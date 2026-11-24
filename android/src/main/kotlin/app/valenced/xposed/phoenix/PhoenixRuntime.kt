package app.valenced.xposed.phoenix

import android.content.pm.ApplicationInfo
import android.os.Build
import app.valenced.logger
import app.valenced.xposed.ValencedConstants
import app.valenced.xposed.ensureDir
import app.valenced.xposed.tweaks.bridge.ValencedBridgeRegistry
import java.io.File
import java.util.zip.ZipFile

/**
 * The QuickJS runtime Valenced ships for Discord's Phoenix client, which has no JS engine of its own.
 *
 * Phoenix runs native code, so every entry point here crosses JNI into `libvalenced_phoenix.so`.
 * Bridge payloads and results travel as JSON, which carries the same value types the React Native
 * path carries through `Arguments.makeNativeObject`.
 */
object PhoenixRuntime {
    private val log = logger("phoenixRuntime")

    @Volatile
    private var handle: Long = 0L

    @Volatile
    private var libraryLoaded = false

    val isRunning: Boolean get() = handle != 0L

    fun start(modulePath: String, appInfo: ApplicationInfo): Boolean {
        if (handle != 0L) return true
        if (!loadLibrary(modulePath, appInfo)) return false

        handle = try {
            nativeCreate(this)
        } catch (e: Throwable) {
            log.e("Unable to create the Phoenix JS runtime", e)
            return false
        }

        if (handle == 0L) {
            log.e("The Phoenix JS runtime failed to start, see the ValencedPhoenix logcat tag")
            return false
        }

        ValencedBridgeRegistry.jsTransport = { module, method, args ->
            val error = nativeCallJS(handle, module, method, encodeJson(args))
            if (error != null) log.e("Calling $module.$method in JS failed: $error")
        }
        return true
    }

    /**
     * Patches Phoenix's native client access evaluator to accept this account.
     *
     * The evaluator is the only function in `liblibdiscord_wasm_host.so` referencing the
     * experiment table entry for `2026-11-phoenix-app-access`. It is found by that anchor and
     * rewritten to return true, so a build whose code moved is skipped instead of corrupted.
     */
    fun patchAccessGate(modulePath: String, appInfo: ApplicationInfo): AccessPatch {
        if (!loadLibrary(modulePath, appInfo)) return AccessPatch.FAILED
        return when (nativePatchAccessGate()) {
            0 -> AccessPatch.PATCHED
            1 -> AccessPatch.ALREADY
            2 -> AccessPatch.NOT_LOADED
            3 -> AccessPatch.NO_ANCHOR
            4 -> AccessPatch.UNSUPPORTED
            else -> AccessPatch.FAILED
        }
    }

    /**
     * Points every gateway registry entry at the runtime's detour, so a plugin can see, drop or
     * replace any event. The registry is the `{name, length, handler}` table holding
     * `MESSAGE_CREATE`, plus the domain reducers behind `READY_SUPPLEMENTAL`.
     */
    fun hookGateway(): GatewayHook {
        val current = handle
        if (current == 0L) return GatewayHook.NOT_LOADED
        return when (nativeHookGateway(current)) {
            0 -> GatewayHook.HOOKED
            1 -> GatewayHook.ALREADY
            2 -> GatewayHook.NOT_LOADED
            3 -> GatewayHook.NO_ANCHOR
            else -> GatewayHook.FAILED
        }
    }

    fun stop() {
        val current = handle
        if (current == 0L) return
        handle = 0L
        ValencedBridgeRegistry.jsTransport = null
        nativeDestroy(current)
    }

    /** Evaluates [source] as global code. Returns the error text, or null on success. */
    fun evaluate(source: ByteArray, filename: String): String? {
        val current = handle
        if (current == 0L) return "The Phoenix JS runtime is not running"
        return nativeEvaluate(current, source, filename)
    }

    /** Forwards a `GuestHost.applyOps` frame. See [FrameVerdict] for the return shape. */
    fun applyOps(frame: ByteArray?, length: Int): ByteArray? {
        val current = handle
        return if (current == 0L) null else nativeApplyOps(current, frame, length)
    }

    /** Forwards a `GuestHost.invoke` frame. See [FrameVerdict] for the return shape. */
    fun invoke(frame: ByteArray?): ByteArray? {
        val current = handle
        return if (current == 0L) null else nativeInvoke(current, frame)
    }

    /** Forwards a `WasmRuntime.nativeDispatch` frame. See [FrameVerdict] for the return shape. */
    fun dispatch(target: Long, frame: ByteArray?): ByteArray? {
        val current = handle
        return if (current == 0L) null else nativeDispatch(current, target, frame)
    }

    @Suppress("unused")
    private fun callSyncFromJS(payload: String): String {
        val call = decodeCall(payload) ?: return encodeJson(mapOf("error" to "Invalid bridge payload"))
        return encodeJson(ValencedBridgeRegistry.dispatch(call.first, call.second))
    }

    @Suppress("unused")
    private fun callAsyncFromJS(payload: String, callId: Long) {
        val current = handle
        val call = decodeCall(payload)
        if (call == null) {
            if (current != 0L) nativeResolve(current, callId, encodeJson(mapOf("error" to "Invalid bridge payload")))
            return
        }

        ValencedBridgeRegistry.dispatchAsync(call.first, call.second) { response ->
            val live = handle
            if (live != 0L) nativeResolve(live, callId, encodeJson(response))
        }
    }

    /**
     * Loads `libvalenced_phoenix.so`. LSPatch merges the module's libraries into the patched
     * splits, so the usual lookup works there. Under a real LSPosed install it does not, and the
     * library has to come out of the module APK.
     */
    private fun loadLibrary(modulePath: String, appInfo: ApplicationInfo): Boolean {
        if (libraryLoaded) return true

        try {
            System.loadLibrary(ValencedConstants.PHOENIX_LIBRARY)
            libraryLoaded = true
            return true
        } catch (_: UnsatisfiedLinkError) {
            log.i("No ${ValencedConstants.PHOENIX_LIBRARY} in the app's library path, extracting it from the module")
        }

        return try {
            System.load(extractLibrary(modulePath, appInfo).path)
            libraryLoaded = true
            true
        } catch (e: Throwable) {
            log.e("Unable to load ${ValencedConstants.PHOENIX_LIBRARY}", e)
            false
        }
    }

    private fun extractLibrary(modulePath: String, appInfo: ApplicationInfo): File {
        val name = "lib${ValencedConstants.PHOENIX_LIBRARY}.so"
        val module = File(modulePath)
        val target = File(appInfo.dataDir, "${ValencedConstants.CACHE_DIR}/native")
            .apply { ensureDir() }
            .let { File(it, "${module.lastModified()}-$name") }

        if (target.isFile) return target

        ZipFile(module).use { zip ->
            val entry = Build.SUPPORTED_ABIS.firstNotNullOfOrNull { zip.getEntry("lib/$it/$name") }
                ?: error("The module APK has no $name for ${Build.SUPPORTED_ABIS.joinToString()}")

            val temp = File(target.path + ".tmp")
            zip.getInputStream(entry).use { source -> temp.outputStream().use(source::copyTo) }
            if (!temp.renameTo(target)) error("Unable to place $name at ${target.path}")
        }
        return target
    }

    private external fun nativePatchAccessGate(): Int
    private external fun nativeHookGateway(handle: Long): Int
    private external fun nativeCreate(host: Any): Long
    private external fun nativeDestroy(handle: Long)
    private external fun nativeEvaluate(handle: Long, source: ByteArray, filename: String): String?
    private external fun nativeCallJS(handle: Long, module: String, method: String, argsJson: String): String?
    private external fun nativeResolve(handle: Long, callId: Long, resultJson: String?)
    private external fun nativeApplyOps(handle: Long, frame: ByteArray?, length: Int): ByteArray?
    private external fun nativeInvoke(handle: Long, frame: ByteArray?): ByteArray?
    private external fun nativeDispatch(handle: Long, target: Long, frame: ByteArray?): ByteArray?
}

/** Outcome of [PhoenixRuntime.patchAccessGate]. Only [NOT_LOADED] is worth retrying. */
enum class AccessPatch { PATCHED, ALREADY, NOT_LOADED, NO_ANCHOR, UNSUPPORTED, FAILED }

/** Outcome of [PhoenixRuntime.hookGateway]. Only [NOT_LOADED] is worth retrying. */
enum class GatewayHook { HOOKED, ALREADY, NOT_LOADED, NO_ANCHOR, FAILED }

/**
 * How the native side reports a frame handler's decision.
 *
 * A null frame passes through. Otherwise the first byte is 0 for a `false` return, 2 for `true`,
 * or 1 to replace the payload with the remaining bytes. Op frames treat `false` as a drop.
 */
object FrameVerdict {
    fun isDrop(verdict: ByteArray) = verdict.isNotEmpty() && verdict[0] == 0.toByte()
    fun isTrue(verdict: ByteArray) = verdict.isNotEmpty() && verdict[0] == 2.toByte()
    fun payload(verdict: ByteArray): ByteArray? =
        if (verdict.isNotEmpty() && verdict[0] == 1.toByte()) verdict.copyOfRange(1, verdict.size) else null
}

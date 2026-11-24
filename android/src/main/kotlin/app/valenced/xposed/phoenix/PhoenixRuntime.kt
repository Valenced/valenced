package app.valenced.xposed.phoenix

import android.content.pm.ApplicationInfo
import android.os.Build
import app.valenced.logger
import app.valenced.xposed.ValencedConstants
import app.valenced.xposed.ensureDir
import app.valenced.xposed.tweaks.bridge.ValencedBridgeRegistry
import java.io.File
import java.util.zip.ZipFile

object PhoenixRuntime {
    private val log = logger("phoenixRuntime")

    @Volatile
    private var handle: Long = 0L

    @Volatile
    private var libraryLoaded = false

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

    fun evaluate(source: ByteArray, filename: String): String? {
        val current = handle
        if (current == 0L) return "The Phoenix JS runtime is not running"
        return nativeEvaluate(current, source, filename)
    }

    fun applyOps(frame: ByteArray?, length: Int): ByteArray? {
        val current = handle
        return if (current == 0L) null else nativeApplyOps(current, frame, length)
    }

    fun invoke(frame: ByteArray?): ByteArray? {
        val current = handle
        return if (current == 0L) null else nativeInvoke(current, frame)
    }

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

    // LSPatch merges the module's libraries into the app. Under LSPosed they have to come out of the module APK.
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
            val name = "lib${ValencedConstants.PHOENIX_LIBRARY}.so"
            val module = File(modulePath)
            val target = File(appInfo.dataDir, "${ValencedConstants.CACHE_DIR}/native")
                .apply { ensureDir() }
                .let { File(it, "${module.lastModified()}-$name") }

            if (!target.isFile) ZipFile(module).use { zip ->
                val entry = Build.SUPPORTED_ABIS.firstNotNullOfOrNull { zip.getEntry("lib/$it/$name") }
                    ?: error("The module APK has no $name for ${Build.SUPPORTED_ABIS.joinToString()}")

                val temp = File(target.path + ".tmp")
                zip.getInputStream(entry).use { source -> temp.outputStream().use(source::copyTo) }
                if (!temp.renameTo(target)) error("Unable to place $name at ${target.path}")
            }

            System.load(target.path)
            libraryLoaded = true
            true
        } catch (e: Throwable) {
            log.e("Unable to load ${ValencedConstants.PHOENIX_LIBRARY}", e)
            false
        }
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

enum class AccessPatch { PATCHED, ALREADY, NOT_LOADED, NO_ANCHOR, UNSUPPORTED, FAILED }

enum class GatewayHook { HOOKED, ALREADY, NOT_LOADED, NO_ANCHOR, FAILED }

object FrameVerdict {
    fun isDrop(verdict: ByteArray) = verdict.isNotEmpty() && verdict[0] == 0.toByte()
    fun isTrue(verdict: ByteArray) = verdict.isNotEmpty() && verdict[0] == 2.toByte()
    fun payload(verdict: ByteArray): ByteArray? =
        if (verdict.isNotEmpty() && verdict[0] == 1.toByte()) verdict.copyOfRange(1, verdict.size) else null
}

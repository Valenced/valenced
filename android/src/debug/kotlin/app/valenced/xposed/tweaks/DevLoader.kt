package app.valenced.xposed.tweaks

import android.app.AlertDialog
import android.util.AtomicFile
import android.widget.Toast
import androidx.core.util.writeBytes
import app.valenced.logger
import app.valenced.reloadApp
import app.valenced.xposed.*
import app.valenced.xposed.tweaks.base.withAppActivity
import app.valenced.xposed.tweaks.bridge.ValencedBridgeRegistry
import app.valenced.xposed.tweaks.plugins.internal.showRecoveryAlert
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import io.ktor.websocket.send
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.Serializable
import java.io.File
import kotlin.time.Duration.Companion.seconds

@Serializable
data class CustomLoadUrl(
    val enabled: Boolean = false,
    val url: String = "",
    val manifestUrl: String = "",
    val phoenixUrl: String = "",
)

@Serializable
data class LoaderConfig(
    val customLoadUrl: CustomLoadUrl = CustomLoadUrl(),
    val devToolsUrl: String = "",
)

/**
 * Loads a development bundle in place of the one shipped in the APK. Debug builds only.
 *
 * Downloads the bundle (and optionally its manifest and the Phoenix bundle) from the custom URL in
 * `files/valenced/loader.json`, and runs scripts in `files/valenced/preloads/` before it. Without a custom URL,
 * the shipped bundle runs. In Phoenix, connects to the DevTools server at `devToolsUrl`.
 */
object DevLoader {
    private val TIMEOUT = 10.seconds
    private val TIMEOUT_CACHED = 5.seconds
    private const val ETAG_PATH = "etag.txt"
    private const val PHOENIX_ETAG_PATH = "phoenix-etag.txt"
    private val DEVTOOLS_RETRY = 5.seconds
    private const val CONFIG_PATH = "loader.json"

    private val log = logger("devLoader")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var config = LoaderConfig()
    private lateinit var bundle: File
    private lateinit var manifest: File
    private lateinit var etag: File
    private lateinit var phoenixBundle: File
    private lateinit var phoenixEtag: File
    private lateinit var configFile: File
    private lateinit var preloadsDir: File

    private val downloadReady = CompletableDeferred<Unit>()
    private val phoenixReady = CompletableDeferred<Unit>()

    @Volatile
    private var devToolsQueue: Channel<String>? = null

    private val customLoadUrl get() = config.customLoadUrl.takeIf { it.enabled && it.url.isNotEmpty() }

    internal fun init(dataDir: String) {
        val cacheDir = File(dataDir, ValencedConstants.CACHE_DIR).apply { mkdirs() }
        val filesDir = File(dataDir, ValencedConstants.FILES_DIR).apply { mkdirs() }

        bundle = File(cacheDir, ValencedConstants.MAIN_SCRIPT_FILE)
        manifest = File(cacheDir, ValencedConstants.BUNDLE_MANIFEST_FILE)
        etag = File(cacheDir, ETAG_PATH)
        phoenixBundle = File(cacheDir, ValencedConstants.PHOENIX_BUNDLE_ASSET)
        phoenixEtag = File(cacheDir, PHOENIX_ETAG_PATH)
        configFile = File(filesDir, CONFIG_PATH)
        preloadsDir = File(filesDir, ValencedConstants.PRELOADS_DIR).apply { mkdirs() }

        config = runCatching {
            if (configFile.exists()) ValencedJson.decodeFromString<LoaderConfig>(configFile.readText())
            else LoaderConfig()
        }.getOrDefault(LoaderConfig())
    }

    /** Waits for the first download, then returns the downloaded bundle, or null to run the shipped one. */
    fun awaitBundle(): File? {
        if (customLoadUrl == null) return null

        runBlocking {
            try {
                withTimeout(TIMEOUT) { downloadReady.await() }
            } catch (e: Throwable) {
                e.rethrowIfCancelled()
                log.w("Bundle download did not complete", e)
            }
        }

        return bundle.takeIf { it.exists() && it.length() > 0 }
    }

    /** Waits for the first Phoenix download, then returns the downloaded bundle, or null to run the shipped one. */
    fun awaitPhoenixBundle(): File? {
        if (customLoadUrl?.phoenixUrl.isNullOrEmpty()) return null

        runBlocking {
            try {
                withTimeout(TIMEOUT) { phoenixReady.await() }
            } catch (e: Throwable) {
                e.rethrowIfCancelled()
                log.w("Phoenix bundle download did not complete", e)
            }
        }

        return phoenixBundle.takeIf { it.exists() && it.length() > 0 }
    }

    /** The downloaded bundle manifest, or null to use the shipped one. */
    fun readBundleManifest(): String? {
        if (customLoadUrl == null) return null
        return manifest.takeIf { it.exists() }?.readText()
    }

    /** Scripts to run before the bundle, in name order. */
    fun preloads(): List<File> = preloadsDir.walk().filter { it.isFile }.sorted().toList()

    /** Extra recovery options for developers. */
    val recoveryOptions: List<Pair<String, () -> Unit>> = listOf(
        "Delete Downloaded Bundle" to {
            if (bundle.exists()) bundle.delete()
            if (phoenixBundle.exists()) phoenixBundle.delete()
            reloadApp()
        },
        "Reset Loader Config" to {
            if (configFile.exists()) configFile.delete()
            reloadApp()
        },
    )

    /**
     * Trigger a download. If [userInitiated] is true (retry from the error dialog), the timeout
     * is disabled and a success dialog is shown on the next available activity.
     */
    fun downloadScript(userInitiated: Boolean = false, showDialog: Boolean = true): Job = scope.launch {
        try {
            val custom = customLoadUrl ?: return@launch
            log.i("Fetching JS bundle from: ${custom.url}")

            val result = httpClient.getWithETag(
                url = custom.url,
                etag = if (etag.exists() && bundle.exists()) etag.readText() else null,
                timeoutMillis = if (userInitiated) null
                else if (bundle.exists()) TIMEOUT_CACHED.inWholeMilliseconds else TIMEOUT.inWholeMilliseconds,
            )

            when (result) {
                is ETagFetchResult.Fetched -> {
                    AtomicFile(bundle).writeBytes(result.bytes)
                    result.etag?.let(etag::writeText) ?: etag.delete()

                    log.i("Bundle updated (${result.bytes.size} bytes)")

                    downloadManifest(custom.manifestUrl)

                    if (showDialog) {
                        if (userInitiated) showSuccessDialog() else showUpdateDialog()
                    }
                }

                ETagFetchResult.NotModified -> log.i("Server responded with 304, no changes")
            }
        } catch (e: Throwable) {
            log.e("Failed to download script", e)
            showErrorDialog(e)
        } finally {
            downloadReady.complete(Unit)
        }
    }

    fun downloadPhoenixScript(): Job = scope.launch {
        try {
            val url = customLoadUrl?.phoenixUrl?.takeIf { it.isNotEmpty() } ?: return@launch
            log.i("Fetching Phoenix bundle from: $url")

            val result = httpClient.getWithETag(
                url = url,
                etag = if (phoenixEtag.exists() && phoenixBundle.exists()) phoenixEtag.readText() else null,
                timeoutMillis = if (phoenixBundle.exists()) TIMEOUT_CACHED.inWholeMilliseconds else TIMEOUT.inWholeMilliseconds,
            )

            when (result) {
                is ETagFetchResult.Fetched -> {
                    AtomicFile(phoenixBundle).writeBytes(result.bytes)
                    result.etag?.let(phoenixEtag::writeText) ?: phoenixEtag.delete()
                    log.i("Phoenix bundle updated (${result.bytes.size} bytes)")
                }

                ETagFetchResult.NotModified -> log.i("Server responded with 304, no Phoenix bundle changes")
            }
        } catch (e: Throwable) {
            log.e("Failed to download the Phoenix bundle", e)
        } finally {
            phoenixReady.complete(Unit)
        }
    }

    /** Connects the Phoenix runtime to the DevTools server at `devToolsUrl`, and reconnects when it drops. */
    fun connectDevTools() {
        val url = config.devToolsUrl.takeIf { it.isNotEmpty() } ?: return

        ValencedBridgeRegistry.registerMethod("valenced.devtools.send") { args ->
            devToolsQueue?.trySend(args.first() as String)
            null
        }

        scope.launch {
            val client = HttpClient(CIO) { install(WebSockets) }
            while (true) {
                try {
                    client.webSocket(url) {
                        val queue = Channel<String>(Channel.UNLIMITED)
                        devToolsQueue = queue
                        log.i("Connected to DevTools at $url")
                        launch { for (text in queue) send(text) }

                        try {
                            ValencedBridgeRegistry.callJSMethod("valenced.devtools.open", emptyList())
                            for (frame in incoming) if (frame is Frame.Text)
                                ValencedBridgeRegistry.callJSMethod("valenced.devtools.message", listOf(frame.readText()))
                        } finally {
                            devToolsQueue = null
                            queue.close()
                            withContext(NonCancellable) {
                                ValencedBridgeRegistry.callJSMethod("valenced.devtools.close", emptyList())
                            }
                            log.i("Disconnected from DevTools")
                        }
                    }
                } catch (e: Throwable) {
                    e.rethrowIfCancelled()
                    log.d("Unable to connect to DevTools at $url", e)
                }
                delay(DEVTOOLS_RETRY)
            }
        }
    }

    private suspend fun downloadManifest(manifestUrl: String) {
        if (manifestUrl.isEmpty()) return

        try {
            val result = httpClient.getWithETag(url = manifestUrl, etag = null, timeoutMillis = null)
            if (result is ETagFetchResult.Fetched) {
                AtomicFile(manifest).writeBytes(result.bytes)
                log.i("Bundle manifest updated (${result.bytes.size} bytes)")
            }
        } catch (e: Throwable) {
            e.rethrowIfCancelled()
            log.w("Failed to download bundle manifest", e)
        }
    }

    private fun showUpdateDialog() = withAppActivity { activity ->
        activity.runOnUiThread {
            AlertDialog.Builder(activity)
                .setTitle("Valenced Update Downloaded")
                .setMessage("A reload is required for changes to take effect.")
                .setPositiveButton("Reload") { d, _ -> reloadApp(); d.dismiss() }
                .setNegativeButton("Later") { d, _ -> d.dismiss() }
                .show()
        }
    }

    private fun showSuccessDialog() = withAppActivity { activity ->
        activity.runOnUiThread {
            AlertDialog.Builder(activity)
                .setTitle("Valenced Update Successful")
                .setMessage("A reload is required for changes to take effect.")
                .setPositiveButton("Reload") { d, _ -> reloadApp(); d.dismiss() }
                .setNegativeButton("Later") { d, _ -> d.dismiss() }
                .show()
        }
    }

    private fun showErrorDialog(e: Throwable) = withAppActivity { activity ->
        activity.runOnUiThread {
            AlertDialog.Builder(activity)
                .setTitle("Valenced Update Failed")
                .setMessage(
                    """
                    Unable to download the development bundle.

                    Error: ${e.message ?: e.stackTraceToString()}
                    """.trimIndent()
                )
                .setNegativeButton("Dismiss") { d, _ -> d.dismiss() }
                .setPositiveButton("Retry Update") { d, _ ->
                    downloadScript(userInitiated = true)
                    Toast.makeText(activity, "Retrying download in background...", Toast.LENGTH_SHORT).show()
                    d.dismiss()
                }
                .setNeutralButton("Recovery") { d, _ -> showRecoveryAlert(activity); d.dismiss() }
                .show()
        }
    }
}

/**
 * Wires [DevLoader] into the lifecycle. Loads the loader config, then kicks off the first download
 * once the target [android.content.Context] is available.
 */
val devLoader by tweak {
    DevLoader.init(appInfo.dataDir)

    withAppContext {
        DevLoader.downloadScript(userInitiated = false, showDialog = false)
        DevLoader.downloadPhoenixScript()
    }
}

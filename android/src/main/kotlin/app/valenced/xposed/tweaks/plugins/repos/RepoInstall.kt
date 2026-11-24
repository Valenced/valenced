package app.valenced.xposed.tweaks.plugins.repos

import app.valenced.plugins.PluginErrorCodes
import app.valenced.plugins.PluginManifest
import app.valenced.plugins.PluginSystemError
import app.valenced.plugins.external.validate
import app.valenced.plugins.repos.ArtifactRequest
import app.valenced.plugins.repos.DownloadedArtifact
import app.valenced.plugins.repos.RepoInstallAction
import app.valenced.plugins.repos.installBegin
import app.valenced.plugins.repos.installSubmit
import app.valenced.xposed.httpClient
import app.valenced.xposed.refusedHttpsDowngradeTarget
import app.valenced.xposed.tweaks.plugins.*
import app.valenced.xposed.tweaks.plugins.external.parseExternalPluginDir
import app.valenced.xposed.tweaks.plugins.external.readParsedPlugin
import io.ktor.client.*
import io.ktor.client.call.*
import io.ktor.client.plugins.*
import io.ktor.client.request.*
import io.ktor.http.*

private const val DOWNLOAD_TIMEOUT = 60_000L

internal class InstallPlanResult(
    /** Brand-new plugins to be loaded in order. */
    val fresh: List<PluginFactory>,
    /**
     * Actions applied on disk only (updates to installed IDs + fresh installs that need them).
     * Nothing running was touched, these can load at next boot.
     */
    val pending: List<RepoInstallAction>,
)

internal class DownloadProgress(
    val action: RepoInstallAction,
    /** Bytes received so far. */
    val received: Long,
    /** 1-based position of this artifact in the plan. */
    val index: Int,
    /** Number of artifacts in the plan. */
    val count: Int,
)

/**
 * Downloads an install plan's artifacts, then hands them to core to verify, extract and apply.
 *
 * [knownManifests] must contain the currently registered plugin manifests.
 * Applied manifests are added on top so intra-plan dependencies validate.
 */
internal suspend fun executeInstallPlan(
    actions: List<RepoInstallAction>,
    dataDir: String,
    knownManifests: Map<String, PluginManifest>,
    isUpdate: (String) -> Boolean,
    isPendingReload: (String) -> Boolean,
    onProgress: (DownloadProgress) -> Unit = {},
): InstallPlanResult {
    if (actions.isEmpty()) return InstallPlanResult(emptyList(), emptyList())

    val requests = installBegin(actions)
    val downloads = requests.mapIndexed { i, request ->
        val emit = throttledProgress(request.action, i + 1, requests.size, onProgress)
        emit(0)
        val bytes = download(httpClient, request, emit)
        emit(request.size)
        DownloadedArtifact(request.action, bytes)
    }

    val applied = installSubmit(pluginPaths(dataDir), downloads, isUpdate, isPendingReload)

    // Apply, dependencies before dependents, including the staged plugins.
    val effectiveManifests = knownManifests + applied.associate { it.action.id to it.manifest.toPluginManifest() }
    return InstallPlanResult(
        fresh = applied.filterNot { it.deferred }
            .map { readParsedPlugin(parseExternalPluginDir(it.dir.toFile()), effectiveManifests, pluginClient) },
        pending = applied.filter { it.deferred }.map { it.action },
    )
}

/** Milliseconds between progress ticks per artifact. */
private const val PROGRESS_INTERVAL_MS = 150L

/**
 * The first (0 bytes) and final (size bytes) ticks always pass.
 * For in between, at most one tick per [PROGRESS_INTERVAL_MS] or per 10% received.
 */
private fun throttledProgress(
    action: RepoInstallAction,
    index: Int,
    count: Int,
    onProgress: (DownloadProgress) -> Unit,
): (Long) -> Unit {
    var lastTime = 0L
    var lastBytes = -1L
    val delta = (action.size / 10).coerceAtLeast(1)
    return { received ->
        val now = System.currentTimeMillis()
        if (received == 0L || received >= action.size ||
            now - lastTime >= PROGRESS_INTERVAL_MS || received - lastBytes >= delta
        ) {
            lastTime = now
            lastBytes = received
            onProgress(DownloadProgress(action, received, index, count))
        }
    }
}

/** Downloads one artifact. Core verifies its size and digest before anything reaches `dist/`. */
private suspend fun download(
    client: HttpClient,
    request: ArtifactRequest,
    onReceived: (Long) -> Unit,
): ByteArray {
    val response = client.get(request.url) {
        timeout { requestTimeoutMillis = DOWNLOAD_TIMEOUT }
        onDownload { received, _ -> onReceived(received) }
    }

    response.refusedHttpsDowngradeTarget()?.let {
        throw PluginSystemError(
            PluginErrorCodes.INSTALL_FAILED,
            "Failed to download ${request.action.id}@${request.action.version}: " +
                "${request.url} redirects to insecure $it. The host should enforce HTTPS.",
        )
    }

    if (response.status != HttpStatusCode.OK) {
        throw PluginSystemError(
            PluginErrorCodes.INSTALL_FAILED,
            "Failed to download ${request.action.id}@${request.action.version}: ${response.status}",
        )
    }

    return response.body()
}

package app.valenced.xposed.tweaks.plugins.external

import android.app.Activity
import android.content.Intent
import app.valenced.plugins.PluginErrorCodes
import app.valenced.plugins.PluginManifest
import app.valenced.plugins.PluginSystemError
import app.valenced.plugins.Version
import app.valenced.plugins.external.ExternalManifest
import app.valenced.plugins.external.StagedPlugin
import app.valenced.plugins.external.applyStagedPlugin
import app.valenced.plugins.external.discardStagedPlugin
import app.valenced.plugins.external.stagePluginZip
import app.valenced.plugins.pluginLog
import app.valenced.xposed.*
import app.valenced.xposed.api.HostScope
import app.valenced.xposed.tweaks.plugins.*
import java.util.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okio.source

private const val PICK_ZIP_REQUEST_CODE = 0x5256

/** Prefix of the temp directory holding a staged install until the user answers. */
private const val CONFIRM_TMP_PREFIX = ".confirm-"

@Volatile
private var pickZipHooked = false

@Volatile
private var pendingPick: ((Activity, android.net.Uri) -> Unit)? = null

internal class InstallPrompt(
    val token: String,
    val manifest: ExternalManifest,
    /** The installed version this would replace. */
    val replaces: Version?,
)

internal sealed class InstallResult {
    /** A new plugin can load right away. */
    class New(val factory: PluginFactory) : InstallResult()

    /** An update, files are on disk. The new code loads next session. */
    class Updated(val manifest: ExternalManifest, val version: Version) : InstallResult()
}

/** Staged sideload installs, keyed by single-use token. At most one at a time. */
private val pendingInstalls = mutableMapOf<String, StagedPlugin>()

/**
 * Opens the document picker for a plugin ZIP, extracts and validates it, then runs [onReady].
 *
 * The callback sends the confirmation event to JS, which calls [confirmPluginInstall] to apply or discard.
 * A new pick discards the previous staged install if there is one.
 */
context(host: HostScope)
internal fun promptInstallPlugin(
    installedVersion: (String) -> Version?,
    /** Throws when the staged plugin must not be installed. */
    requireInstallable: (String) -> Unit,
    onReady: (Result<InstallPrompt>) -> Unit,
) {
    if (!pickZipHooked) {
        pickZipHooked = true

        Activity::class.java.method(
            "onActivityResult",
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Intent::class.java,
        ).hook {
            after {
                if (args[0] as Int != PICK_ZIP_REQUEST_CODE) return@after

                val callback = pendingPick ?: return@after
                pendingPick = null

                val uri = (args[2] as? Intent)?.data
                if (args[1] as Int != Activity.RESULT_OK || uri == null) return@after

                callback(thisObject as Activity, uri)
            }
        }
    }

    pendingPick = { activity, uri ->
        pluginJobScope.launch(Dispatchers.IO) {
            val paths = pluginPaths(host.appInfo.dataDir)

            val result = runCatching {
                discardPendingInstalls(host.appInfo.dataDir)

                val token = UUID.randomUUID().toString()
                val input = activity.contentResolver.openInputStream(uri)
                    ?: throw PluginSystemError(PluginErrorCodes.STORAGE_FAILED, "Unable to open $uri")

                val staged = input.use { stream ->
                    stagePluginZip(paths, "$CONFIRM_TMP_PREFIX$token") { it.writeAll(stream.source()) }
                }

                try {
                    requireInstallable(staged.manifest.id)
                } catch (e: Throwable) {
                    discardStagedPlugin(paths, staged)
                    throw e
                }

                pendingInstalls[token] = staged
                InstallPrompt(token, staged.manifest, replaces = installedVersion(staged.manifest.id))
            }.onFailure { pluginLog.e("Failed to stage plugin from $uri", it) }

            onReady(result)
        }
    }

    host.withAppActivity { activity ->
        activity.startActivityForResult(
            Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/zip"
            },
            PICK_ZIP_REQUEST_CODE,
        )
    }
}

/**
 * Applies or discards a staged sideload install.
 * Unknown/stale token, or a decline discards the staged files.
 *
 * @return The applied [InstallResult], or `null` when nothing was applied.
 */
internal fun confirmPluginInstall(
    token: String,
    accepted: Boolean,
    dataDir: String,
    knownManifests: Map<String, PluginManifest>,
    isUpdate: (String) -> Boolean,
): InstallResult? {
    val paths = pluginPaths(dataDir)
    val staged = pendingInstalls.remove(token)
    if (staged == null || !accepted) {
        staged?.let { discardStagedPlugin(paths, it) }
        return null
    }

    val dir = try {
        applyStagedPlugin(paths, staged)
    } catch (e: Throwable) {
        discardStagedPlugin(paths, staged)
        throw e
    }

    return if (isUpdate(staged.manifest.id)) {
        InstallResult.Updated(staged.manifest, Version.parse(staged.manifest.version))
    } else {
        InstallResult.New(readExternalPluginDir(dir.toFile(), knownManifests, pluginClient))
    }
}

private fun discardPendingInstalls(dataDir: String) {
    val paths = pluginPaths(dataDir)
    for (staged in pendingInstalls.values) discardStagedPlugin(paths, staged)
    pendingInstalls.clear()
}

package app.valenced.plugins.external

import app.valenced.core.Lock
import app.valenced.plugins.PluginErrorCodes
import app.valenced.plugins.PluginPaths
import app.valenced.plugins.PluginSystemError
import app.valenced.plugins.pluginLog
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okio.Path

private val replacementLock = Lock()

internal fun replaceInstalledPlugin(paths: PluginPaths, stagedDir: Path, id: String): Path =
    replacementLock.withLock { PluginReplacement(paths, stagedDir, id).commit() }

fun restoreInterruptedReplacements(paths: PluginPaths): List<String> = replacementLock.withLock {
    val fs = paths.fs
    fs.listOrNull(paths.backups).orEmpty().mapNotNull { backup ->
        val dest = paths.dist / backup.name
        if (fs.exists(dest)) return@mapNotNull null

        runCatching {
            fs.createDirectories(paths.dist)
            fs.atomicMove(backup, dest)
        }.onFailure {
            pluginLog.e("Failed to restore '${backup.name}' from $backup", it)
        }.map { backup.name }.getOrNull()
    }
}

private class PluginReplacement(
    private val paths: PluginPaths,
    private val staged: Path,
    private val id: String,
) {
    private val fs = paths.fs
    private val dest = paths.dist / id
    private val backup = paths.backups / id

    fun commit(): Path {
        fs.createDirectories(paths.dist)
        fs.createDirectories(paths.backups)

        recoverInterruptedReplacement()
        discardStaleBackup()

        if (fs.exists(dest)) replaceInstalled() else installFresh()
        return dest
    }

    private fun installFresh() {
        try {
            fs.atomicMove(staged, dest)
        } catch (cause: Throwable) {
            throw PluginSystemError(PluginErrorCodes.INSTALL_FAILED, "Could not install '$id'", cause)
        }
    }

    private fun replaceInstalled() {
        setInstalledAside()
        moveStagedIntoPlace()
        dropBackup()
    }

    private fun setInstalledAside() {
        try {
            fs.atomicMove(dest, backup)
        } catch (cause: Throwable) {
            if (fs.exists(dest)) throw PluginSystemError(
                PluginErrorCodes.INSTALL_FAILED,
                "Could not back up the installed '$id'; it was left untouched",
                cause,
            )
            throw rollback(cause)
        }
    }

    private fun moveStagedIntoPlace() {
        try {
            fs.atomicMove(staged, dest)
        } catch (cause: Throwable) {
            throw rollback(cause)
        }
    }

    private fun rollback(cause: Throwable): PluginSystemError {
        val failure = runCatching { restoreBackup() }.exceptionOrNull()
            ?: return PluginSystemError(
                PluginErrorCodes.INSTALL_FAILED,
                "Could not install '$id'; the previous version was restored",
                cause,
            )

        cause.addSuppressed(failure)
        return PluginSystemError(
            PluginErrorCodes.INSTALL_FAILED,
            "Could not install '$id' and the previous version could not be restored automatically. " +
                "It is preserved at $backup; move it back to $dest to recover it",
            cause,
            buildJsonObject {
                put("backupPath", backup.toString())
                put("pluginPath", dest.toString())
            },
        )
    }

    private fun restoreBackup() {
        check(fs.exists(backup)) { "The backup at $backup is missing" }
        fs.deleteRecursively(dest, mustExist = false)
        fs.atomicMove(backup, dest)
    }

    private fun recoverInterruptedReplacement() {
        if (fs.exists(dest) || !fs.exists(backup)) return

        try {
            fs.atomicMove(backup, dest)
            pluginLog.w("Restored '$id' from an interrupted update")
        } catch (cause: Throwable) {
            throw PluginSystemError(
                PluginErrorCodes.INSTALL_FAILED,
                "An earlier update of '$id' was interrupted and its previous version could not be restored. " +
                    "It is preserved at $backup; move it back to $dest to recover it",
                cause,
                buildJsonObject {
                    put("backupPath", backup.toString())
                    put("pluginPath", dest.toString())
                },
            )
        }
    }

    private fun discardStaleBackup() {
        if (!fs.exists(backup)) return

        try {
            fs.deleteRecursively(backup)
        } catch (cause: Throwable) {
            throw PluginSystemError(
                PluginErrorCodes.INSTALL_FAILED,
                "Could not remove the leftover backup of '$id' at $backup; the installed version was left untouched",
                cause,
            )
        }
    }

    private fun dropBackup() {
        runCatching { fs.deleteRecursively(backup, mustExist = false) }
            .onFailure { pluginLog.w("Could not remove the backup of '$id' at $backup", it) }
    }
}

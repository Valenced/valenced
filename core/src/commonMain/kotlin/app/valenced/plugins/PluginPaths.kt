package app.valenced.plugins

import okio.FileSystem
import okio.Path

/**
 * Every path the plugin system owns, rooted at the host app's data directory.
 *
 * The [fs] travels with the paths so tests can hand the stores a `FakeFileSystem` and production
 * hands them `FileSystem.SYSTEM`.
 *
 * ```
 * files/valenced/plugins/
 *   dist/<id>/          installed plugin files
 *   backups/<id>/       previous version while an update is committed
 *   storage/<slot>/<id> per-slot plugin storage
 *   states/             slot pointers and slot files
 *   repos/              repos.json, sources.json and the index caches
 * ```
 *
 * [rootOverride] exists for the iOS tweak, whose existing on-disk layout is `<Documents>/valenced/plugins`
 * rather than the Android-style `<dataDir>/files/valenced/plugins`.
 */
class PluginPaths(
    val fs: FileSystem,
    val dataDir: Path,
    rootOverride: Path? = null,
) {
    val root: Path = rootOverride ?: dataDir / "files" / "valenced" / "plugins"

    /** Installed plugin directories, one per plugin ID. */
    val dist: Path = root / "dist"

    val backups: Path = root / "backups"

    /** Parent of the per-slot storage roots. */
    val storage: Path = root / "storage"

    val states: Path = root / "states"
    val slots: Path = states / "slots"

    /** Pointer file naming the slot the user chose. */
    val activeSlotFile: Path = states / "active"

    /** Pointer file naming the one-shot slot, consumed on the next boot. */
    val nextSlotFile: Path = states / "next"

    val repos: Path = root / "repos"

    /** Plugin storage root for one slot, so slots isolate plugin data as well as flags. */
    fun storageFor(slotId: String): Path = storage / slotId

    /**
     * A plugin's storage directory in every slot that has one, whether or not this boot loaded that slot.
     *
     * Uninstall is a cross-slot action: a directory left behind would resurrect the plugin's data on reinstall.
     */
    fun storageDirsOfAllSlots(pluginId: String): List<Path> = fs.listOrNull(storage).orEmpty()
        .filter { fs.metadataOrNull(it)?.isDirectory == true }
        .map { it / pluginId }
}

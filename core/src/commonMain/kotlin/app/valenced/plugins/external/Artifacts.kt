package app.valenced.plugins.external

import app.valenced.core.ValencedJson
import app.valenced.plugins.PluginErrorCodes
import app.valenced.plugins.PluginPaths
import app.valenced.plugins.PluginSystemError
import okio.Buffer
import okio.BufferedSink
import okio.FileSystem
import okio.Path
import okio.Path.Companion.toPath
import okio.Source
import okio.buffer
import okio.openZip

/** Largest decompressed size of a plugin ZIP (1 GiB). */
const val MAX_EXTRACTED_ZIP_BYTES: Long = 1L shl 30

private const val COPY_CHUNK = 8 * 1024L

/** An extracted and validated plugin ZIP that hasn't replaced the existing install yet. */
class StagedPlugin(val dir: Path, val manifest: ExternalManifest)

/**
 * Spools a plugin ZIP into `<dist>/<tmpName>.zip`, extracts it into `<dist>/<tmpName>/`, then parses
 * and validates its manifest.
 *
 * [writeZip] receives the spool sink, so the host can stream from a socket, a `content://` URI or a
 * byte array without core knowing how it got the bytes.
 *
 * The manifest is read from the ZIP's directory and validated *before* anything is extracted, which
 * is a security property rather than an optimisation. Extraction stops at [MAX_EXTRACTED_ZIP_BYTES]
 * decompressed bytes.
 */
fun stagePluginZip(paths: PluginPaths, tmpName: String, writeZip: (BufferedSink) -> Unit): StagedPlugin {
    val fs = paths.fs
    fs.createDirectories(paths.dist)

    val tmp = paths.dist / tmpName
    fs.deleteRecursively(tmp, mustExist = false)
    fs.createDirectories(tmp)

    val spool = paths.dist / "$tmpName.zip"

    try {
        fs.write(spool) { writeZip(this) }

        val zip = try {
            fs.openZip(spool)
        } catch (e: Throwable) {
            throw PluginSystemError(PluginErrorCodes.INSTALL_INVALID_ZIP, "Not a readable ZIP: ${e.message}", e)
        }

        val manifestEntry = "/$MANIFEST_FILE".toPath()
        if (zip.metadataOrNull(manifestEntry)?.isRegularFile != true) throw PluginSystemError(
            PluginErrorCodes.INSTALL_INVALID_ZIP,
            "Not a Valenced plugin ZIP: missing $MANIFEST_FILE",
        )

        val manifest = try {
            ValencedJson.decodeFromString(
                ExternalManifest.serializer(),
                zip.read(manifestEntry) { readUtf8() },
            ).also { it.validate() }
        } catch (e: PluginSystemError) {
            throw e
        } catch (e: Throwable) {
            throw PluginSystemError(PluginErrorCodes.MANIFEST_INVALID, "Invalid $MANIFEST_FILE: ${e.message}", e)
        }

        extractInto(zip, tmp, fs)

        return StagedPlugin(tmp, manifest)
    } catch (e: Throwable) {
        fs.deleteRecursively(tmp, mustExist = false)
        throw e
    } finally {
        runCatching { fs.delete(spool, mustExist = false) }
    }
}

private fun extractInto(zip: FileSystem, tmp: Path, fs: FileSystem) {
    var budget = MAX_EXTRACTED_ZIP_BYTES

    for (entry in zip.listRecursively("/".toPath())) {
        val relative = entry.toString().trimStart('/')
        if (relative.isEmpty()) continue

        val out = (tmp / relative).normalized()
        if (!out.toString().startsWith("$tmp${Path.DIRECTORY_SEPARATOR}")) throw PluginSystemError(
            PluginErrorCodes.INSTALL_INVALID_ZIP,
            "ZIP entry escapes the install directory: $relative",
        )

        if (zip.metadataOrNull(entry)?.isDirectory == true) {
            fs.createDirectories(out)
            continue
        }

        out.parent?.let { fs.createDirectories(it) }
        val source = zip.source(entry)
        try {
            val sink = fs.sink(out).buffer()
            try {
                budget -= sink.writeCapped(source, budget)
            } finally {
                sink.close()
            }
        } finally {
            source.close()
        }
    }
}

/** Copies [source], throwing once more than [budget] decompressed bytes have been read. */
private fun BufferedSink.writeCapped(source: Source, budget: Long): Long {
    val buffer = Buffer()
    var total = 0L

    while (true) {
        val read = source.read(buffer, COPY_CHUNK)
        if (read == -1L) break

        total += read
        if (total > budget) {
            buffer.clear()
            throw PluginSystemError(
                PluginErrorCodes.INSTALL_INVALID_ZIP,
                "Plugin ZIP expands past the $MAX_EXTRACTED_ZIP_BYTES-byte limit",
            )
        }

        writeAll(buffer)
    }

    return total
}

/**
 * Creates or replaces `<dist>/<id>/` with a staged plugin.
 *
 * The running session keeps running the code it already loaded. The new files take effect next boot.
 */
fun applyStagedPlugin(paths: PluginPaths, staged: StagedPlugin): Path =
    replaceInstalledPlugin(paths, staged.dir, staged.manifest.id)

/** Deletes a staged directory that will never be applied. */
fun discardStagedPlugin(paths: PluginPaths, staged: StagedPlugin) {
    runCatching { paths.fs.deleteRecursively(staged.dir, mustExist = false) }
}

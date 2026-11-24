package app.valenced.xposed.tweaks.plugins.external

import app.valenced.plugins.PluginDependencyGraph
import app.valenced.plugins.PluginManifest
import app.valenced.plugins.PluginSystemError
import app.valenced.plugins.external.ExternalManifest
import app.valenced.plugins.external.ExternalPluginClient
import app.valenced.plugins.external.MANIFEST_FILE
import app.valenced.plugins.external.validate
import app.valenced.plugins.plugin
import app.valenced.plugins.pluginLog
import app.valenced.xposed.ValencedJson
import app.valenced.xposed.requireInside
import app.valenced.xposed.tweaks.plugins.PluginFactory
import java.io.File

/** Parses and validates a `<id>/manifest.json`. */
internal fun parseExternalPluginDir(dir: File): ParsedExternalPlugin = ParsedExternalPlugin(
    dir,
    ValencedJson.decodeFromString(ExternalManifest.serializer(), File(dir, MANIFEST_FILE).readText())
        .also { it.validate() },
)

/**
 * Creates [PluginFactory] from `<id>/` directory.
 *
 * Throws on malformed manifest, missing required dependencies/unsatisfied version range.
 * Unavailable optional dependencies are dropped with a warning.
 *
 * @param knownManifests Every plugin installed, used to resolve this plugin's dependencies.
 */
internal fun readExternalPluginDir(
    dir: File,
    knownManifests: Map<String, PluginManifest>,
    client: ExternalPluginClient,
): PluginFactory = readParsedPlugin(parseExternalPluginDir(dir), knownManifests, client)

/** [readExternalPluginDir] for a directory that is already parsed. */
internal fun readParsedPlugin(
    parsed: ParsedExternalPlugin,
    knownManifests: Map<String, PluginManifest>,
    client: ExternalPluginClient,
): PluginFactory {
    val manifest = parsed.manifest.toPluginManifest()
    val id = manifest.id

    val graph = PluginDependencyGraph(knownManifests + (id to manifest))

    for (depId in manifest.dependencies.keys) {
        val problem = graph.problem(id, depId) ?: continue

        if (manifest.dependencies.getValue(depId).optional) {
            pluginLog.w("Optional ${problem.reason} for plugin '$id'; ignoring")
        } else {
            throw PluginSystemError(problem.code, "Plugin '$id': ${problem.reason}")
        }
    }

    return buildExternalFactory(parsed, client)
}

internal fun buildExternalFactory(
    parsed: ParsedExternalPlugin,
    client: ExternalPluginClient,
): PluginFactory {
    val (dir, manifest) = parsed.dir to parsed.manifest

    val pluginManifest = manifest.toPluginManifest()

    val (entryName, entry) = when (client) {
        ExternalPluginClient.REACT_NATIVE -> "script" to manifest.dist?.script
        ExternalPluginClient.PHOENIX -> "phoenix" to manifest.dist?.phoenix
    }
    val scriptPath = entry?.let { script ->
        val file = File(dir, script)
        file.requireInside(dir, "dist.$entryName", script)
        if (!file.isFile) {
            pluginLog.i("dist.$entryName does not exist, skipping JS for ${pluginManifest.id}: $script")
            null
        } else {
            file.absolutePath
        }
    }

    val android = manifest.dist?.android

    pluginLog.i("Discovered external plugin: ${pluginManifest.id} ${pluginManifest.version}")

    return PluginFactory(pluginManifest, scriptPath = scriptPath) { chain ->
        // JS-only plugin, no native body.
        if (android == null) plugin {}
        else {
            val dexCache = File(dir.parentFile, DEX_CACHE_DIR).apply { mkdirs() }
            loadNativeBuilder(dir, dexCache, android, manifest.id, chain.mapNotNull { nativePluginLoaders[it] })
        }
    }
}

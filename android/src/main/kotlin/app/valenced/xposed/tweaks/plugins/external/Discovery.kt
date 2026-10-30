package app.valenced.xposed.tweaks.plugins.external

import app.valenced.plugins.PluginDependencyGraph
import app.valenced.plugins.PluginError
import app.valenced.plugins.PluginErrorCodes
import app.valenced.plugins.PluginManifest
import app.valenced.plugins.external.DiscoveryFailure
import app.valenced.plugins.external.ExternalManifest
import app.valenced.plugins.external.MANIFEST_FILE
import app.valenced.plugins.external.ParsedPlugin
import app.valenced.plugins.external.restoreInterruptedReplacements
import app.valenced.plugins.external.sessionSkip
import app.valenced.plugins.pluginLog
import app.valenced.xposed.tweaks.plugins.*
import java.io.File

/** Plugin directory with parsed manifest, but unloaded artifacts. */
internal class ParsedExternalPlugin(val dir: File, manifest: ExternalManifest) : ParsedPlugin(manifest)

internal class ExternalDiscovery(
    val factories: List<PluginFactory>,
    /** Keyed by plugin ID, or directory name if manifest failed to parse. */
    val failures: Map<String, DiscoveryFailure>,
)

/**
 * Reads installed plugins in `<dataDir>/files/valenced/plugins/dist`.
 * Each plugin has its own `<id>/` directory with a [MANIFEST_FILE] and `dist` artifacts.
 *
 * Dependency resolution happens at [PluginDependencyGraph].
 */
internal fun discoverExternalPlugins(
    dataDir: String,
    internalManifests: Map<String, PluginManifest>,
): ExternalDiscovery {
    val failures = mutableMapOf<String, DiscoveryFailure>()
    runCatching { restoreInterruptedReplacements(pluginPaths(dataDir)) }
        .onFailure { pluginLog.e("Failed to restore interrupted plugin updates", it) }

    val root = externalPluginsRoot(dataDir)
    if (!root.isDirectory) return ExternalDiscovery(emptyList(), failures)

    // Temp files and spooled ZIPs left mid-install.
    root.listFiles { it.name.startsWith(".") && it.name != DEX_CACHE_DIR }
        ?.forEach { it.deleteRecursively() }

    // Plugin IDs can't start with a dot.
    val dirs = root.listFiles { it.isDirectory && !it.name.startsWith(".") }
        ?: return ExternalDiscovery(emptyList(), failures)

    val parsed = mutableMapOf<String, ParsedExternalPlugin>()
    for (dir in dirs) {
        if (!File(dir, MANIFEST_FILE).isFile) continue

        try {
            val plugin = parseExternalPluginDir(dir)
            // Internal plugins win over installed copies without provenance.
            // Stubs are handled outside the Discovery flow.
            if (plugin.manifest.id in internalManifests) {
                pluginLog.w("Ignoring installed copy of internal plugin '${plugin.manifest.id}' in '${dir.name}'")
                continue
            }
            parsed[plugin.manifest.id] = plugin
        } catch (e: Throwable) {
            failures[dir.name] = DiscoveryFailure(
                null,
                listOf(
                    PluginError(
                        PluginErrorCodes.MANIFEST_INVALID,
                        "Failed to read plugin manifest: ${e.message}",
                    ),
                ),
            )
            pluginLog.e("Failed to read external plugin in '${dir.name}'", e)
        }
    }

    // toPluginManifest shouldn't throw since we already validate()d them.
    val graph = PluginDependencyGraph(
        internalManifests + parsed.mapValues { (_, plugin) -> plugin.manifest.toPluginManifest() },
    )
    val order = graph.loadOrder()

    for ((id, problems) in order.dropped) {
        val plugin = parsed[id] ?: continue
        failures.sessionSkip(
            id, plugin.manifest.toPluginManifest(),
            problems.map { PluginError(it.code, "Unsatisfied dependency: ${it.reason}") },
        )
    }

    for (id in order.cycles) {
        val plugin = parsed[id] ?: continue
        failures.sessionSkip(
            id, plugin.manifest.toPluginManifest(),
            listOf(PluginError(PluginErrorCodes.DEPENDENCY_CYCLE, "Dependency cycle")),
        )
    }

    // The graph doesn't know if a directory describes a plugin at all.
    // This only builds the factory, loading the plugin's code happens at [loadPlugin] for enabled plugins only.
    // A failed required dependency must skip the dependent, a failed optional one just goes ignored/unchained.
    val failed = mutableSetOf<String>()
    val result = mutableListOf<PluginFactory>()
    for (id in order.ordered) {
        val plugin = parsed[id] ?: continue

        val failedRequired = graph.requiredDependencies(id).intersect(failed)
        if (failedRequired.isNotEmpty()) {
            failed += id
            failures.sessionSkip(
                id, plugin.manifest.toPluginManifest(),
                failedRequired.map {
                    PluginError(PluginErrorCodes.DEPENDENCY_FAILED, "Dependency '$it' failed to load")
                },
            )
            continue
        }

        try {
            result += buildExternalFactory(plugin)
        } catch (e: Throwable) {
            failed += id
            failures[id] = DiscoveryFailure(
                plugin.manifest.toPluginManifest(),
                listOf(PluginError(PluginErrorCodes.LOAD_FAILED, "Failed to load: ${e.message}")),
            )
            pluginLog.e("Failed to load external plugin '$id'", e)
        }
    }

    return ExternalDiscovery(result, failures)
}

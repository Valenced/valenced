package app.valenced.xposed.tweaks.plugins

import app.valenced.plugins.PluginErrorCodes
import app.valenced.plugins.PluginStatesStore
import app.valenced.plugins.external.ExternalPluginClient
import app.valenced.plugins.external.MANIFEST_FILE
import app.valenced.plugins.pluginLog
import app.valenced.plugins.repos.SourcesStore
import app.valenced.plugins.toPluginError
import app.valenced.xposed.Tweak
import app.valenced.xposed.tweak
import app.valenced.xposed.tweaks.onLaunchDecision
import app.valenced.xposed.tweaks.plugins.external.discoverExternalPlugins
import app.valenced.xposed.tweaks.plugins.internal.*
import java.io.File

val pluginLoader by tweak {
    // The launch choice is made after all tweaks register. Resolve client-specific distributions
    // only once PhoenixLaunch has reported the client that will actually start.
    val host = this
    onLaunchDecision { phoenix ->
        pluginClient = if (phoenix) ExternalPluginClient.PHOENIX else ExternalPluginClient.REACT_NATIVE
        host.loadPlugins(pluginClient)
    }
}

private fun Tweak.loadPlugins(client: ExternalPluginClient) {
    val errors = mutableListOf<String>()

    // Load states before anything reads or writes a slot.
    PluginStatesStore.ensureLoaded(pluginPaths(appInfo.dataDir))

    // Register default provenances.
    val sources = SourcesStore.ensureLoaded(pluginPaths(appInfo.dataDir)).toMutableMap()
    for ((id, source) in defaultSourcesToSeed(allInternalPlugins, sources)) {
        runCatching { SourcesStore.set(id, source) }
            .onSuccess { sources[id] = source }
            .onFailure { pluginLog.e("Failed to record stub source for $id", it) }
    }

    // Installed copies of internals with provenance win, and load as external plugins.
    val distRoot = externalPluginsRoot(appInfo.dataDir)
    val shadowed = shadowedInternalIds(allInternalPlugins, sources) { id ->
        File(File(distRoot, id), MANIFEST_FILE).isFile
    }
    for (id in shadowed) pluginLog.i("Using installed copy of internal plugin: $id")

    val known = allInternalPlugins.filterNot { it.manifest.id in shadowed }

    val discovery = discoverExternalPlugins(
        appInfo.dataDir,
        known.associate { it.manifest.id to it.manifest },
        client,
    )
    val external = discovery.factories

    pluginRegistry.recordDiscoveryFailures(discovery.failures)

    // Some discovery errors aren't hard errors (unsatisfied deps), but won't allow the plugins to run in this session.
    // They can run once the issues are resolved (e.g. loader/plugin/Discord update).
    for ((id, failure) in discovery.failures) {
        // Prefer the validated manifest's ID, since [id] could be a directory name instead.
        if (failure.isPluginFault) clearBootSlotFlags(failure.manifest?.id ?: id)
    }

    for (factory in known + external) pluginRegistry.add(factory)

    PluginStatesStore.batchSave {
        val slot = PluginStatesStore.boot

        for (factory in known + external) {
            val manifest = factory.manifest

            try {
                val essential = InternalPluginFlags.ESSENTIAL in factory.internalFlags
                val enabledByDefault = InternalPluginFlags.ENABLED_BY_DEFAULT in factory.internalFlags

                val shouldLoad = slot.isPluginEnabled(manifest.id) ||
                        essential ||
                        (enabledByDefault && !slot.hasPlugin(manifest.id))

                if (!shouldLoad) {
                    pluginLog.i("Skipping disabled plugin: ${manifest.id}")
                    continue
                }
                loadPlugin(factory)
            } catch (e: Throwable) {
                val err = "Failed to load plugin ${manifest.id}: ${e.message}"
                errors += err
                pluginRegistry.bootErrors[manifest.id] = e.toPluginError(PluginErrorCodes.LOAD_FAILED)
                pluginLog.e(err, e)
            }
        }
    }

    pluginLog.i("Loaded ${pluginRegistry.loaded.size} plugins with ${errors.size} errors")
    for (err in errors) pluginLog.e(err)
}

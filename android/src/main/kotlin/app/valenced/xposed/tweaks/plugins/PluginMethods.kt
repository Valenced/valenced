package app.valenced.xposed.tweaks.plugins

import app.valenced.bridge.asDelegate
import app.valenced.core.ValencedJson
import app.valenced.plugins.PluginErrorCodes
import app.valenced.plugins.PluginFlags
import app.valenced.plugins.PluginStatesStore
import app.valenced.plugins.PluginSystemError
import app.valenced.plugins.external.requireValidPluginId
import app.valenced.plugins.pluginLog
import app.valenced.plugins.repos.SourcesStore
import app.valenced.plugins.toJSPayload
import app.valenced.xposed.tweak
import app.valenced.xposed.tweaks.plugins.internal.InternalPluginFlags
import app.valenced.xposed.tweaks.plugins.internal.internalPluginOf
import java.io.File
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement

val pluginMethods by tweak {
    pluginSystemMethod("valenced.plugins.getConstants") {
        mapOf(
            "storageRootPath" to pluginStorageRoot(appInfo.dataDir).absolutePath,
            "distRootPath" to externalPluginsRoot(appInfo.dataDir).absolutePath,
            "defaultsOnlySlot" to PluginStatesStore.DEFAULTS_SLOT,
        )
    }

    pluginSystemMethod("valenced.plugins.list") {
        val sources = SourcesStore.ensureLoaded(pluginPaths(appInfo.dataDir))
        pluginRegistry.factories.values.map { factory ->
            factory.toJSPayload(
                pluginRegistry.loaded[factory.manifest.id],
                pluginRegistry.bootErrors[factory.manifest.id],
                sources[factory.manifest.id],
            )
        } + pluginRegistry.discoveryFailures.mapNotNull { (id, failure) ->
            // Only failures with validated manifests
            val manifest = failure.manifest ?: return@mapNotNull null
            failure.toJSPayload(manifest, sources[id])
        }
    }

    /**
     * `valenced.plugins.stop(id)`
     *
     * JS has already stopped its half down and cascaded. This stops the native half.
     */
    pluginSystemAsyncMethod("valenced.plugins.stop") { args ->
        val argv = args.asDelegate()
        val pluginId by argv.string()

        stopNativePlugin(pluginId)
        null
    }

    /**
     * `valenced.plugins.restart(id)`
     *
     * See [restartPlugin].
     */
    pluginSystemAsyncMethod("valenced.plugins.restart") { args ->
        val argv = args.asDelegate()
        val pluginId by argv.string()

        restartPlugin(pluginId)
        null
    }

    pluginSystemAsyncMethod("valenced.plugins.uninstall") { args ->
        val argv = args.asDelegate()
        val pluginId by argv.string()

        val factory = pluginRegistry.factories[pluginId]
        if (factory != null && InternalPluginFlags.INTERNAL in factory.internalFlags)
            throw PluginSystemError(
                PluginErrorCodes.NOT_ALLOWED,
                "Plugin $pluginId is internal and cannot be uninstalled",
            )

        // Disable first (cascading to linked dependents), then remove.
        // Disabling also stops the native side and cancels the flag persistence job, so it can't re-persist.
        disablePlugin(pluginId)
        pluginRegistry.forget(pluginId)

        requireValidPluginId(pluginId)

        // Delete data from all slots.
        File(pluginPaths(appInfo.dataDir).backups.toFile(), pluginId).deleteRecursively()
        File(externalPluginsRoot(appInfo.dataDir), pluginId).deleteRecursively()
        for (dir in pluginStorageDirsOfAllSlots(appInfo.dataDir, pluginId)) dir.deleteRecursively()
        PluginStatesStore.removePluginFromAllSlots(pluginPaths(appInfo.dataDir), pluginId)
        runCatching { SourcesStore.remove(pluginId) }
            .onFailure { pluginLog.e("Failed to remove plugin source for $pluginId", it) }

        pluginLog.i("Uninstalled plugin: $pluginId")

        // Uninstalling updates restores the internal plugin, registered like a fresh install.
        val restored = internalPluginOf(pluginId)?.let { stub ->
            pluginRegistry.add(stub)
            stub.defaultSource?.let { source ->
                runCatching { SourcesStore.set(pluginId, source) }
                    .onFailure { pluginLog.e("Failed to record stub source for $pluginId", it) }
            }

            pluginLog.i("Restored internal plugin: $pluginId")
            stub.toJSPayload(source = SourcesStore[pluginId])
        }

        emitDependencyGraphUpdate()
        mapOf("restored" to restored)
    }

    pluginSystemAsyncMethod("valenced.plugins.setEnabled") { args ->
        val argv = args.asDelegate()
        val pluginId by argv.string()
        val enabled by argv.boolean()
        val requiredByUser by argv.booleanOrNull()

        val factory = pluginRegistry.factories[pluginId]
        val entry = pluginRegistry.loaded[pluginId]

        if (enabled) {
            // Required deps must be installed, satisfied and enabled first. JS must handle the resolution UX.
            val problems = factory?.dependencyProblemsToJSPayload(pluginRegistry.factories).orEmpty()
            if (problems.isNotEmpty()) throw PluginSystemError(
                PluginErrorCodes.DEPENDENCIES_UNSATISFIED,
                unsatisfiedDependenciesMessage(pluginId, problems),
                details = buildJsonObject { put("problems", ValencedJson.encodeToJsonElement(problems)) },
            )

            val requiredByUser = requiredByUser == true

            // In a defaults boot this only enables the plugin for the session, since the boot slot is ephemeral.
            // enablePlugin writes the slot the user chose.
            entry?.let { it.scope.flags.value += pluginEnablementFlags(requiredByUser) }
            enablePlugin(pluginId, requiredByUser)
        } else {
            // Note that essential plugins will be rejected by disablePlugin itself.
            // Required dependents get automatically disabled with it, linked optionals just stop.
            disablePlugin(pluginId)
        }
        null
    }

    /**
     * `valenced.plugins.setHeld(id, held) -> Source`
     *
     * Holds a plugin at its installed version, or resumes following its channel.
     * A hold skips update checks and stops the resolver from moving the plugin to satisfy something else.
     */
    pluginSystemAsyncMethod("valenced.plugins.setHeld") { args ->
        val pluginId = args.getOrNull(0) as? String
            ?: throw PluginSystemError(PluginErrorCodes.INVALID_ARGUMENT, "Expected a plugin ID")
        val held = args.getOrNull(1) as? Boolean
            ?: throw PluginSystemError(PluginErrorCodes.INVALID_ARGUMENT, "Expected a boolean")

        SourcesStore.ensureLoaded(pluginPaths(appInfo.dataDir))

        val factory = pluginRegistry.factories[pluginId]
            ?: throw PluginSystemError(PluginErrorCodes.NOT_FOUND, "Unknown plugin: '$pluginId'")
        // Internals with provenance (stubs) update through their repository.
        if (InternalPluginFlags.INTERNAL in factory.internalFlags && SourcesStore[pluginId] == null)
            throw PluginSystemError(
                PluginErrorCodes.NOT_ALLOWED,
                "Plugin $pluginId is internal and updates with Valenced itself",
            )

        SourcesStore.setHeld(pluginId, held).toJSPayload()
    }
}

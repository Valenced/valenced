package app.valenced.xposed.tweaks.plugins

import app.valenced.core.toNative
import app.valenced.plugins.PluginErrorCodes
import app.valenced.plugins.PluginFlags
import app.valenced.plugins.PluginSystemError
import app.valenced.plugins.external.validatedPluginIcon
import app.valenced.plugins.pluginLog
import app.valenced.plugins.repos.InstallPlan
import app.valenced.plugins.repos.PlanTarget
import app.valenced.plugins.repos.PluginSource
import app.valenced.plugins.repos.REPO_CHANNEL_LATEST
import app.valenced.plugins.repos.RepoInstallAction
import app.valenced.plugins.repos.RepoStore
import app.valenced.plugins.repos.ResolveRequest
import app.valenced.plugins.repos.SourcesStore
import app.valenced.plugins.repos.findUpdates
import app.valenced.plugins.repos.parseRepoInstallAction
import app.valenced.plugins.repos.repoInstallMutex
import app.valenced.plugins.repos.resolveInstall
import app.valenced.plugins.toJSPayload
import app.valenced.plugins.toPluginError
import app.valenced.xposed.api.HostScope
import app.valenced.xposed.api.callJSMethod
import app.valenced.xposed.runSuspendCatching
import app.valenced.xposed.tweak
import app.valenced.xposed.tweaks.plugins.external.InstallResult
import app.valenced.xposed.tweaks.plugins.external.confirmPluginInstall
import app.valenced.xposed.tweaks.plugins.external.promptInstallPlugin
import app.valenced.xposed.tweaks.plugins.internal.InternalPluginFlags
import app.valenced.xposed.tweaks.plugins.repos.*
import kotlinx.coroutines.sync.withLock

val pluginInstallMethods by tweak {
    pluginSystemMethod("valenced.plugins.installFile") {
        SourcesStore.ensureLoaded(pluginPaths(appInfo.dataDir))
        promptInstallPlugin(
            installedVersion = { id -> pluginRegistry.factories[id]?.manifest?.version },
            requireInstallable = ::requireReplaceable,
        ) { result ->
            result.fold(
                // Emit a ready event and wait for confirmation.
                onSuccess = { prompt ->
                    emitPluginEvent(
                        PluginEvents.PLUGIN_INSTALL_FILE_READY,
                        mapOf(
                            "token" to prompt.token,
                            "manifest" to mapOf(
                                "id" to prompt.manifest.id,
                                "name" to prompt.manifest.name,
                                "description" to prompt.manifest.description,
                                "author" to prompt.manifest.author,
                                "version" to prompt.manifest.version,
                                "icon" to prompt.manifest.icon?.let(::validatedPluginIcon),
                            ),
                            "replaces" to prompt.replaces?.toString(),
                        ),
                    )
                },
                onFailure = { e ->
                    emitPluginEvent(
                        PluginEvents.PLUGIN_INSTALL_RESULT,
                        mapOf("error" to e.toPluginError(PluginErrorCodes.INSTALL_FAILED).toJSPayload()),
                    )
                },
            )
        }
        null
    }

    /**
     * `valenced.plugins.confirmInstallFile(token, accepted) -> "cancelled" | "installed" | "pending"`
     *
     * Answers a [PluginEvents.PLUGIN_INSTALL_FILE_READY] prompt.
     * `accepted = false`, or an unknown/stale token discards the plan and returns `cancelled`.
     *
     * Accepting applies the staged install, returning `installed` for a fresh plugin (registers disabled),
     * `pending` for an update (applies after reload).
     */
    pluginSystemAsyncMethod("valenced.plugins.confirmInstallFile") { args ->
        val token = args.getOrNull(0) as? String
            ?: throw PluginSystemError(PluginErrorCodes.INVALID_ARGUMENT, "Expected an install token")
        val accepted = args.getOrNull(1) as? Boolean ?: false

        val outcome = confirmPluginInstall(
            token,
            accepted,
            appInfo.dataDir,
            pluginRegistry.installedManifests(),
        ) { it in pluginRegistry.factories }

        val result = when (outcome) {
            null -> "cancelled"
            is InstallResult.New -> "installed"
            is InstallResult.Updated -> "pending"
        }
        outcome?.let { handleInstallResult(it) }
        if (outcome != null) emitDependencyGraphUpdate()
        result
    }

    /**
     * `valenced.plugins.planInstall(id, options?) -> InstallPlan`
     *
     * Resolves an install against cached indexes and returns a plan for JS to confirm and pass to `install`.
     *
     * `options = { repos?: string[], targets?: { [id]: { repo?, version?, channel?, compatible? } }, skipMissingOptionals?: boolean }`:
     * - `repos` only considers those repositories, for every plugin.
     * - `targets` overrides default resolution rules. A `channel` is strict unless `compatible` is set.
     * - `skipMissingOptionals` skips untargeted optional dependencies that aren't installed.
     */
    pluginSystemAsyncMethod("valenced.plugins.planInstall") { args ->
        val id = args.getOrNull(0) as? String
            ?: throw PluginSystemError(PluginErrorCodes.INVALID_ARGUMENT, "Expected a plugin ID")
        val options = args.getOrNull(1)?.let {
            it as? Map<*, *> ?: throw PluginSystemError(
                PluginErrorCodes.INVALID_ARGUMENT,
                "Expected plan options or null"
            )
        }

        val targets = (options?.get("targets") as? Map<*, *>).orEmpty().entries.associate { (key, value) ->
            val target = value as? Map<*, *>
                ?: throw PluginSystemError(PluginErrorCodes.INVALID_ARGUMENT, "Expected a target object for '$key'")
            key as String to PlanTarget(
                repo = target["repo"] as? String,
                version = target["version"] as? String,
                channel = target["channel"] as? String,
                compatible = target["compatible"] == true,
            )
        }
        val filteredRepos = (options?.get("repos") as? List<*>)?.map {
            it as? String
                ?: throw PluginSystemError(PluginErrorCodes.INVALID_ARGUMENT, "Expected a list of repository URLs")
        }

        RepoStore.ensureLoaded(pluginPaths(appInfo.dataDir))
        SourcesStore.ensureLoaded(pluginPaths(appInfo.dataDir))

        val repos =
            RepoStore.list().filter { it.enabled && (filteredRepos?.contains(it.url) ?: true) }.mapNotNull { repo ->
                RepoStore.cachedIndex(repo.url)?.let { repo.url to it }
            }

        val plan = resolveInstall(
            ResolveRequest(id, targets, skipMissingOptionals = options?.get("skipMissingOptionals") == true),
            repos,
            pluginRegistry.installedVersions(),
            SourcesStore.all(),
            pluginRegistry.installedDependencies(),
        )

        for (action in plan.actions) requireReplaceable(action.id)

        mapOf(
            "actions" to plan.actions.map { action ->
                mapOf(
                    "id" to action.id,
                    "version" to action.version.toString(),
                    "url" to action.url,
                    "sha256" to action.sha256,
                    "size" to action.size,
                    "repo" to action.repo,
                    "channel" to action.channel,
                    "hold" to action.hold,
                    "replaces" to action.replaces?.toString(),
                    "channelVersion" to action.channelVersion?.toString(),
                    "dependents" to action.dependents.map { (dependent, how) ->
                        mapOf("id" to dependent, "optional" to how.optional, "range" to how.range.toString())
                    },
                    "candidates" to action.candidates.mapValues { (_, versions) ->
                        versions.mapValues { (_, candidate) -> mapOf("breaks" to candidate.breaks) }
                    },
                )
            },
            "warnings" to plan.warnings.map { it.toJson().toNative() },
        )
    }

    /**
     * `valenced.plugins.install(plan) -> { installed, pending, skipped }`
     *
     * Download, verify, and apply on disk. New plugins load immediately. Updates run after a reload.
     * A manifest not matching the plan aborts the whole plan without committing.
     * Actions with exact artifact (version + hash) already on disk are skipped, only recording their source and hold status.
     *
     * Concurrent calls get queued and run one by one, re-checking after each.
     */
    pluginSystemAsyncMethod("valenced.plugins.install") { args ->
        val planMap = args.firstOrNull() as? Map<*, *>
            ?: throw PluginSystemError(PluginErrorCodes.INVALID_ARGUMENT, "Expected an install plan")
        val actions = (planMap["actions"] as? List<*>).orEmpty().map(::parseRepoInstallAction)

        RepoStore.ensureLoaded(pluginPaths(appInfo.dataDir))
        SourcesStore.ensureLoaded(pluginPaths(appInfo.dataDir))

        for (action in actions) requireReplaceable(action.id)

        repoInstallMutex.withLock {
            val todo = mutableListOf<RepoInstallAction>()
            val skipped = mutableListOf<String>()
            for (action in actions) {
                val source = SourcesStore[action.id]
                val onDisk = pluginRegistry.pendingUpdates[action.id]
                    ?: pluginRegistry.factories[action.id]?.manifest?.version

                if (onDisk != action.version || source?.hash != action.sha256) {
                    todo += action
                    continue
                }

                // The exact artifact is on disk already (an overlapping plan installed it), so change the source only.
                val moved = source.repo != action.repo || source.channel != action.channel ||
                        (action.hold != null && source.held != action.hold)
                if (moved) runCatching {
                    SourcesStore.record(action.id, action.repo, action.channel, action.sha256, action.hold)
                }.onFailure { pluginLog.e("Failed to record plugin source for ${action.id}", it) }
                skipped += action.id
            }

            val result = executeInstallPlan(
                todo,
                appInfo.dataDir,
                pluginRegistry.installedManifests(),
                isUpdate = { it in pluginRegistry.factories },
                isPendingReload = { id ->
                    pluginRegistry.loaded[id]?.let { PluginFlags.PENDING_RELOAD in it.scope.flags.value } ?: false
                            || id in pluginRegistry.pendingUpdates
                },
                onProgress = { p ->
                    emitPluginEvent(
                        PluginEvents.DOWNLOAD_PROGRESS,
                        mapOf(
                            "id" to p.action.id,
                            "version" to p.action.version.toString(),
                            "repo" to p.action.repo,
                            "received" to p.received,
                            "total" to p.action.size,
                            "index" to p.index,
                            "count" to p.count,
                        ),
                    )
                },
            )

            for (factory in result.fresh) {
                pluginRegistry.add(factory)
                // Default state for fresh installs.
                clearBootSlotFlags(factory.manifest.id)
                runSuspendCatching {
                    callJSMethod(
                        PluginEvents.PLUGIN_INSTALL_RESULT,
                        listOf(
                            mapOf(
                                "error" to false,
                                "plugin" to factory.toJSPayload(source = SourcesStore[factory.manifest.id]),
                            ),
                        ),
                    )
                }.onFailure { pluginLog.e("Failed to notify JS of plugin install", it) }
            }

            for (action in result.pending) {
                pluginRegistry.pendingUpdates[action.id] = action.version
                runSuspendCatching {
                    callJSMethod(
                        PluginEvents.PLUGIN_UPDATED,
                        listOf(mapOf("id" to action.id, "version" to action.version.toString())),
                    )
                }.onFailure { pluginLog.e("Failed to notify JS of pending update", it) }
            }

            // Update the dependency graph if needed.
            if (result.fresh.isNotEmpty() || result.pending.isNotEmpty()) emitDependencyGraphUpdate()

            mapOf(
                "installed" to result.fresh.map { it.manifest.id },
                "pending" to result.pending.map { it.id },
                "skipped" to skipped,
            )
        }
    }

    /**
     * `valenced.plugins.listUpdates() -> Update[]`
     *
     * Checks cached indexes of enabled repositories against installed plugins. See [findUpdates].
     * Each update comes with structured `warnings`, and a `blocker` when it can't be installed safely.
     */
    pluginSystemAsyncMethod("valenced.plugins.listUpdates") { _ ->
        RepoStore.ensureLoaded(pluginPaths(appInfo.dataDir))
        SourcesStore.ensureLoaded(pluginPaths(appInfo.dataDir))

        val repos = RepoStore.list().filter { it.enabled }.mapNotNull { repo ->
            RepoStore.cachedIndex(repo.url)?.let { repo.url to it }
        }

        findUpdates(
            repos,
            pluginRegistry.installedVersions(),
            pluginRegistry.pendingUpdates,
            SourcesStore.all(),
            pluginRegistry.installedDependencies(),
        ).map { update ->
            mapOf(
                "id" to update.id,
                "installed" to update.installed.toString(),
                "available" to update.available.toString(),
                "channel" to update.channel,
                "channelVersion" to update.channelVersion?.toString(),
                "repo" to update.repo,
                "size" to update.size,
                "includes" to update.includes.map { action ->
                    mapOf(
                        "id" to action.id,
                        "version" to action.version.toString(),
                        "replaces" to action.replaces?.toString(),
                        "size" to action.size,
                    )
                },
                "warnings" to update.warnings.map { it.toJson().toNative() },
                "blocker" to update.blocker?.toJson()?.toNative(),
            )
        }
    }
}

/** Rejects replacing an internal plugin without provenance. Stubs have one, so they can update. */
internal fun requireReplaceable(id: String) {
    val factory = pluginRegistry.factories[id] ?: return
    if (InternalPluginFlags.INTERNAL in factory.internalFlags && SourcesStore[id] == null)
        throw PluginSystemError(
            PluginErrorCodes.NOT_ALLOWED,
            "Plugin $id is built into Valenced and can't be replaced",
        )
}

context(host: HostScope)
private fun handleInstallResult(result: InstallResult) {
    when (result) {
        is InstallResult.New -> {
            val factory = result.factory
            pluginRegistry.add(factory)
            // Default states for fresh installs.
            clearBootSlotFlags(factory.manifest.id)
            val source = PluginSource(repo = null)
            runCatching { SourcesStore.set(factory.manifest.id, source) }
                .onFailure { pluginLog.e("Failed to record plugin source", it) }

            emitPluginEvent(
                PluginEvents.PLUGIN_INSTALL_RESULT,
                mapOf("error" to false, "plugin" to factory.toJSPayload(source = source)),
            )
        }

        is InstallResult.Updated -> {
            pluginRegistry.pendingUpdates[result.manifest.id] = result.version
            runCatching { SourcesStore.set(result.manifest.id, PluginSource(repo = null, hash = null)) }
                .onFailure { pluginLog.e("Failed to record plugin source", it) }

            emitPluginEvent(
                PluginEvents.PLUGIN_UPDATED,
                mapOf("id" to result.manifest.id, "version" to result.manifest.version),
            )
        }
    }
}

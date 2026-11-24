package app.valenced.xposed.tweaks.plugins

import app.valenced.core.toNativeMap
import app.valenced.plugins.PluginError
import app.valenced.plugins.PluginErrorCodes
import app.valenced.plugins.PluginManifest
import app.valenced.plugins.PluginPayload
import app.valenced.plugins.PluginScope
import app.valenced.plugins.SourcePayload
import app.valenced.plugins.external.DiscoveryFailure
import app.valenced.plugins.pluginLog
import app.valenced.plugins.repos.PluginSource
import app.valenced.plugins.toJSPayload
import app.valenced.plugins.toPayload
import app.valenced.plugins.toPluginError
import app.valenced.xposed.tweaks.plugins.internal.InternalPluginFlags
import app.valenced.xposed.tweaks.plugins.internal.internalPluginOf
import java.io.File

internal fun PluginFactory.toJSPayload(
    loaded: LoadedPlugin? = null,
    bootError: PluginError? = null,
    /* `null` = sideloaded */
    source: PluginSource? = null,
): Map<String, Any?> = PluginPayload(
    manifest = manifest.toPayload(),
    script = readScript(),
    internal = InternalPluginFlags.INTERNAL in internalFlags,
    essential = InternalPluginFlags.ESSENTIAL in internalFlags,
    enabledByDefault = InternalPluginFlags.ENABLED_BY_DEFAULT in internalFlags,
    api = InternalPluginFlags.API in internalFlags,
    source = source?.toPayload(),
    hasStub = hasStub(manifest.id, source),
    unsatisfiedOptionalDependencies = pluginRegistry.dependencies
        .unsatisfiedOptionalDependencies(manifest.id).toList(),
    errors = buildList {
        bootError?.let(::add)
        loaded?.let { addAll(it.scope.pluginErrors) }
    },
    compat = compat,
).toNativeMap()

/** Everything the plugin has thrown so far this session. */
val PluginScope.pluginErrors: List<PluginError>
    get() = errors.replayCache.map { it.toPluginError(PluginErrorCodes.PLUGIN_ERROR) }

val PluginScope.errorsJSPayload
    get() = pluginErrors.map { it.toJSPayload() }

internal fun DiscoveryFailure.toJSPayload(
    manifest: PluginManifest,
    source: PluginSource? = null,
): Map<String, Any?> = PluginPayload(
    manifest = manifest.toPayload(),
    script = null,
    internal = false,
    essential = false,
    enabledByDefault = false,
    api = false,
    source = source?.toPayload(),
    hasStub = hasStub(manifest.id, source),
    errors = errors,
    failed = true,
).toNativeMap()

/** Whether uninstalling [id] restores an internal plugin with the same ID. */
private fun hasStub(id: String, source: PluginSource?) = source != null && internalPluginOf(id) != null

internal fun PluginSource.toPayload(): SourcePayload = SourcePayload(repo = repo, channel = channel, held = held)

internal fun PluginSource.toJSPayload(): Map<String, Any?> = toPayload().toNativeMap()

/** Read the plugin's `dist.script` source (if any) for JS to evaluate. */
private fun PluginFactory.readScript(): String? = scriptPath?.let { path ->
    try {
        File(path).readText()
    } catch (e: Throwable) {
        pluginLog.e("Failed to read plugin script for ${manifest.id}: $path", e)
        null
    }
}

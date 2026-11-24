package app.valenced.plugins

import app.valenced.core.API_VERSION_STRING

/**
 * Plugin metadata. Parsed from `manifest.json` for external plugins, written in code for internal ones.
 */
data class PluginManifest(
    val id: String,
    val name: String,
    val description: String,
    /** Author, as `Name <DISCORD_ID> (LINK)`. Discord IDs and links are optional and repeatable, with IDs first. */
    val author: String,
    /** Contributors, in the same format as [author]. */
    val contributors: List<String> = emptyList(),
    val icon: String? = null,
    val settings: List<PluginSettingDefinition>? = null,
    /** Dependencies keyed by plugin ID. */
    val dependencies: Map<String, PluginDependency> = emptyMap(),
    val version: Version,
)

/**
 * A plugin dependency specification.
 * The dependency's plugin ID is the key in [PluginManifest.dependencies].
 */
data class PluginDependency(
    /**
     * Version range the dependency must satisfy.
     *
     * Defaults to [VersionRange.ANY] (any version satisfies the dependency).
     */
    val version: VersionRange = VersionRange.ANY,
    /**
     * When `true`, this dependency never blocks the dependent when missing, version-unsatisfied, or failed to load.
     *
     * When available, the dependency is ordered first and its class loader is chained,
     * so availability is detectable via `Class.forName(name, false, javaClass.classLoader)`.
     */
    val optional: Boolean = false,
)

/**
 * The current Valenced plugin API version.
 */
val API_VERSION: Version = Version.parse(API_VERSION_STRING)

/**
 * The reserved dependency ID resolving to the [API_VERSION].
 *
 * External plugins **MUST** declare a dependency on this ID. Plugins that don't won't be loaded.
 */
const val API_DEPENDENCY_ID: String = "valenced.api"

/**
 * The reserved dependency ID resolving to the host Discord app's version.
 *
 * The version is determined at runtime based on the app the module is loaded into,
 * so it lives in the loader, not here. This library only defines the contract.
 *
 * External plugins **MUST** declare a dependency on this ID. Plugins that don't won't be loaded.
 */
const val DISCORD_DEPENDENCY_ID: String = "discord"

/** Reserved dependency IDs, served by internal provider plugins. */
val RESERVED_DEPENDENCY_IDS: Set<String> = setOf(API_DEPENDENCY_ID, DISCORD_DEPENDENCY_ID)

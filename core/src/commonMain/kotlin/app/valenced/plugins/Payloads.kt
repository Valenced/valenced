package app.valenced.plugins

import app.valenced.plugins.external.MANIFEST_FORMAT
import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable

/** Wire shape of a version: `{ nums, label }`. JS never parses version strings. */
@Serializable
data class VersionPayload(
    val nums: List<Int>,
    val label: String?,
)

@Serializable
data class DependencyPayload(
    val version: String,
    val optional: Boolean,
)

@Serializable
data class ManifestPayload @OptIn(ExperimentalSerializationApi::class) constructor(
    /** Anything that reaches runtime already passed format validation. */
    @EncodeDefault(EncodeDefault.Mode.ALWAYS) val format: Int = MANIFEST_FORMAT,
    val id: String,
    val name: String,
    val description: String,
    val author: String,
    val contributors: List<String>,
    val icon: String?,
    val settings: List<PluginSettingDefinition>?,
    val dependencies: Map<String, DependencyPayload>,
    val version: VersionPayload,
)

/** Install provenance: which repository a plugin came from and whether updates are paused. */
@Serializable
data class SourcePayload(
    val repo: String?,
    val channel: String,
    val held: Boolean,
)

/** One entry of `valenced.plugins.list`. */
@Serializable
data class PluginPayload @OptIn(ExperimentalSerializationApi::class) constructor(
    val manifest: ManifestPayload,
    /** The plugin's JS bundle source, read lazily from disk. */
    val script: String?,
    val internal: Boolean,
    val essential: Boolean,
    val enabledByDefault: Boolean,
    val api: Boolean,
    /** `null` = sideloaded. */
    val source: SourcePayload?,
    val hasStub: Boolean,
    /** Installed optional dependencies that are unsatisfied, so this plugin loaded without linking them. */
    @EncodeDefault(EncodeDefault.Mode.ALWAYS) val unsatisfiedOptionalDependencies: List<String> = emptyList(),
    /** Errors the native side has already hit (for example at boot, before JS was up). */
    @EncodeDefault(EncodeDefault.Mode.ALWAYS) val errors: List<PluginError> = emptyList(),
    /** Discovery failures: the plugin is known but skipped this session. Absent from the payload when false. */
    val failed: Boolean = false,
    /** [script] is the React Native `dist.script`, run by Phoenix through its compat layer. Absent from the payload when false. */
    val compat: Boolean = false,
)

fun Version.toPayload(): VersionPayload = VersionPayload(nums, label)

fun PluginManifest.toPayload(): ManifestPayload = ManifestPayload(
    id = id,
    name = name,
    description = description,
    author = author,
    contributors = contributors,
    icon = icon,
    settings = settings,
    dependencies = dependencies.mapValues { (_, dep) ->
        DependencyPayload(dep.version.toString(), dep.optional)
    },
    version = version.toPayload(),
)

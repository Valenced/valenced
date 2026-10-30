package app.valenced.xposed.tweaks.plugins.internal

import app.valenced.plugins.RESERVED_DEPENDENCY_IDS
import app.valenced.plugins.Version
import app.valenced.plugins.parseBundleManifest
import app.valenced.xposed.tweaks.plugins.PluginFactory
import kotlin.test.Test
import kotlin.test.assertEquals

class BundledPluginsTest {
    private fun parseBundledPlugins(json: String): List<PluginFactory> {
        val manifest = parseBundleManifest(json) ?: error("Failed to parse bundle manifest")
        return bundledPlugins(manifest)
    }

    @Test
    fun `reads ids, dependencies and the bundle version`() {
        val plugins = parseBundledPlugins(
            """
            {
              "version": "1.2.3-rc1",
              "plugins": [
                { "id": "valenced.settings" },
                {
                  "id": "valenced.settings.plugins",
                  "dependencies": { "valenced.settings": { "version": ">=1.0" } }
                }
              ]
            }
            """.trimIndent()
        )

        assertEquals(listOf("valenced.settings", "valenced.settings.plugins"), plugins.map { it.manifest.id })

        val settings = plugins[0].manifest
        assertEquals(Version.parse("1.2.3-rc1"), settings.version)
        // Every plugin carries the reserved dependencies, exactly as a native internal plugin does.
        assertEquals(RESERVED_DEPENDENCY_IDS, settings.dependencies.keys)

        val dep = plugins[1].manifest.dependencies.getValue("valenced.settings")
        assertEquals(">=1.0", dep.version.toString())
        assertEquals(false, dep.optional)
    }

    @Test
    fun `builds an empty plugin, since the implementation is in the bundle`() {
        val plugins = parseBundledPlugins("""{"version":"1.0.0","plugins":[{"id":"valenced.settings"}]}""")
        val factory = plugins.single()

        assertEquals(
            setOf(InternalPluginFlags.INTERNAL),
            factory.internalFlags,
        )
    }

    @Test
    fun `enablement from the manifest`() {
        val plugins = parseBundledPlugins(
            """
            {
              "version": "1.0.0",
              "plugins": [
                { "id": "valenced.settings", "essential": true },
                { "id": "valenced.no-track", "enabledByDefault": true },
                { "id": "valenced.api.hidden" }
              ]
            }
            """.trimIndent()
        )

        val flags = plugins.associate { it.manifest.id to it.internalFlags }

        assertEquals(
            setOf(InternalPluginFlags.INTERNAL, InternalPluginFlags.ESSENTIAL),
            flags.getValue("valenced.settings"),
        )
        assertEquals(
            setOf(InternalPluginFlags.INTERNAL, InternalPluginFlags.ENABLED_BY_DEFAULT),
            flags.getValue("valenced.no-track"),
        )
        // Absent means off: a plugin the build resolved as dev-only-by-default in a release bundle.
        assertEquals(setOf(InternalPluginFlags.INTERNAL), flags.getValue("valenced.api.hidden"))
    }

    @Test
    fun `stubs can override the bundle version`() {
        val plugins = parseBundledPlugins(
            """
            {
              "version": "1.0.0",
              "plugins": [
                { "id": "valenced.api.themes", "version": "0.1.0", "defaultSource": { "repo": "https://example.com" } },
                { "id": "valenced.settings", "version": "2.0.0" }
              ]
            }
            """.trimIndent()
        )

        // Only stubs may, so the other entry is skipped.
        assertEquals(listOf("valenced.api.themes"), plugins.map { it.manifest.id })
        assertEquals(Version.parse("0.1.0"), plugins.single().manifest.version)
    }

    @Test
    fun `stubs carry their metadata`() {
        val plugins = parseBundledPlugins(
            """
            {
              "version": "1.0.0",
              "plugins": [
                {
                  "id": "valenced.settings.themes",
                  "name": "Theme Settings",
                  "description": "Manage your themes.",
                  "author": "Valenced",
                  "icon": "PaintPaletteIcon",
                  "defaultSource": { "repo": "https://example.com" }
                }
              ]
            }
            """.trimIndent()
        )

        val manifest = plugins.single().manifest
        assertEquals("Theme Settings", manifest.name)
        assertEquals("Manage your themes.", manifest.description)
        assertEquals("Valenced", manifest.author)
        assertEquals("PaintPaletteIcon", manifest.icon)
    }

    @Test
    fun `a malformed entry does not take the rest of the set down`() {
        val plugins = parseBundledPlugins(
            """
            {
              "version": "1.0.0",
              "plugins": [
                { "id": "../escape" },
                { "id": "valenced.settings" }
              ]
            }
            """.trimIndent()
        )

        assertEquals(listOf("valenced.settings"), plugins.map { it.manifest.id })
    }
}

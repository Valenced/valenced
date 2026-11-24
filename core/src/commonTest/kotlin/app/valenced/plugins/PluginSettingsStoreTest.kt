package app.valenced.plugins

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okio.Path.Companion.toPath
import okio.fakefilesystem.FakeFileSystem

class PluginSettingsStoreTest {
    private val fs = FakeFileSystem()
    private val paths = PluginPaths(fs, "/data".toPath())
    private val enabled = PluginSettingDefinition("enabled", PluginSettingType.SWITCH, "Enabled", JsonPrimitive(true))
    private val count = PluginSettingDefinition(
        "count",
        PluginSettingType.NUMBER,
        "Count",
        JsonPrimitive(3),
        min = 1.0,
        max = 8.0,
    )

    @Test
    fun `reads defaults and persists changes across reads`() {
        val definitions = listOf(enabled, count)
        assertEquals(JsonPrimitive(true), PluginSettingsStore.read(paths, "example.plugin", definitions)["enabled"])

        PluginSettingsStore.write(paths, "example.plugin", definitions, "enabled", JsonPrimitive(false))
        PluginSettingsStore.write(paths, "example.plugin", definitions, "count", JsonPrimitive(5))

        val values = PluginSettingsStore.read(paths, "example.plugin", definitions)
        assertEquals(JsonPrimitive(false), values["enabled"])
        assertEquals(JsonPrimitive(5), values["count"])
    }

    @Test
    fun `rejects unknown and out of range writes`() {
        val definitions = listOf(enabled, count)

        assertFailsWith<PluginSystemError> {
            PluginSettingsStore.write(paths, "example.plugin", definitions, "missing", JsonPrimitive(true))
        }
        assertFailsWith<PluginSystemError> {
            PluginSettingsStore.write(paths, "example.plugin", definitions, "count", JsonPrimitive(9))
        }
    }

    @Test
    fun `drops removed keys on the next write and deletes the file`() {
        PluginSettingsStore.write(paths, "example.plugin", listOf(enabled, count), "enabled", JsonPrimitive(false))
        PluginSettingsStore.write(paths, "example.plugin", listOf(count), "count", JsonPrimitive(4))

        assertEquals(
            JsonObject(mapOf("count" to JsonPrimitive(4))),
            PluginSettingsStore.read(paths, "example.plugin", listOf(count)),
        )

        PluginSettingsStore.delete(paths, "example.plugin")

        assertFalse(fs.exists(paths.settingsFile("example.plugin")))
    }
}

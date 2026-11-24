package app.valenced.plugins

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
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

    private val limits = PluginSettingDefinition(
        "limits",
        PluginSettingType.OBJECT,
        "Limits",
        settings = listOf(
            PluginSettingDefinition("soft", PluginSettingType.NUMBER, "Soft", JsonPrimitive(1800)),
            PluginSettingDefinition("hard", PluginSettingType.NUMBER, "Hard", JsonPrimitive(2000), max = 4000.0),
        ),
    )
    private val words = PluginSettingDefinition(
        "words",
        PluginSettingType.LIST,
        "Words",
        JsonArray(emptyList()),
        item = PluginSettingType.TEXT,
        maxItems = 2,
    )

    @Test
    fun `writes object members by dotted path and merges nested defaults`() {
        val definitions = listOf(enabled, limits, words)
        assertEquals(
            JsonObject(mapOf("soft" to JsonPrimitive(1800), "hard" to JsonPrimitive(2000))),
            PluginSettingsStore.read(paths, "example.plugin", definitions)["limits"],
        )

        PluginSettingsStore.write(paths, "example.plugin", definitions, "limits.soft", JsonPrimitive(1900))
        PluginSettingsStore.write(paths, "example.plugin", definitions, "words", JsonArray(listOf(JsonPrimitive("a"))))

        val values = PluginSettingsStore.read(paths, "example.plugin", definitions)
        assertEquals(
            JsonObject(mapOf("soft" to JsonPrimitive(1900), "hard" to JsonPrimitive(2000))),
            values["limits"],
        )
        assertEquals(JsonArray(listOf(JsonPrimitive("a"))), values["words"])

        assertFailsWith<PluginSystemError> {
            PluginSettingsStore.write(paths, "example.plugin", definitions, "limits.hard", JsonPrimitive(5000))
        }
        assertFailsWith<PluginSystemError> {
            PluginSettingsStore.write(paths, "example.plugin", definitions, "limits.other", JsonPrimitive(1))
        }
        assertFailsWith<PluginSystemError> {
            PluginSettingsStore.write(paths, "example.plugin", definitions, "enabled.soft", JsonPrimitive(1))
        }
        assertFailsWith<PluginSystemError> {
            PluginSettingsStore.write(
                paths,
                "example.plugin",
                definitions,
                "words",
                JsonArray(listOf(JsonPrimitive("a"), JsonPrimitive("b"), JsonPrimitive("c"))),
            )
        }
    }

    @Test
    fun `migrates valid declared keys from storage json once`() {
        val definitions = listOf(enabled, count, limits)
        val storage = paths.storageFor(PluginStatesStore.activeSlotId) / "example.plugin"
        fs.createDirectories(storage)
        fs.write(storage / "storage.json") {
            writeUtf8("""{ "enabled": false, "count": 99, "other": 1, "limits": { "soft": 10, "hard": "x" } }""")
        }

        val values = PluginSettingsStore.read(paths, "example.plugin", definitions)
        assertEquals(JsonPrimitive(false), values["enabled"])
        assertEquals(JsonPrimitive(3), values["count"])
        assertEquals(JsonObject(mapOf("soft" to JsonPrimitive(10), "hard" to JsonPrimitive(2000))), values["limits"])
        assertTrue(fs.exists(paths.settingsFile("example.plugin")))

        fs.write(storage / "storage.json") { writeUtf8("""{ "enabled": true }""") }
        assertEquals(JsonPrimitive(false), PluginSettingsStore.read(paths, "example.plugin", definitions)["enabled"])

        PluginSettingsStore.clear(paths, "example.plugin", definitions)
        assertEquals(JsonPrimitive(true), PluginSettingsStore.read(paths, "example.plugin", definitions)["enabled"])
    }

    @Test
    fun `plugins without settings get no settings file`() {
        assertEquals(JsonObject(emptyMap()), PluginSettingsStore.read(paths, "example.plugin", emptyList()))
        assertFalse(fs.exists(paths.settingsFile("example.plugin")))
    }
}

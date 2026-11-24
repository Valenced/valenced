package app.valenced.plugins

import app.valenced.core.ValencedJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class PluginSettingTest {
    @Test
    fun `setting definitions validate defaults and type-specific fields`() {
        PluginSettingDefinition("enabled", PluginSettingType.SWITCH, "Enabled", JsonPrimitive(true)).validate()
        PluginSettingDefinition(
            "length",
            PluginSettingType.NUMBER,
            "Length",
            JsonPrimitive(8),
            min = 1.0,
            max = 64.0,
        ).validate()

        assertFailsWith<IllegalArgumentException> {
            PluginSettingDefinition("enabled", PluginSettingType.SWITCH, "Enabled", JsonPrimitive("yes")).validate()
        }
        assertFailsWith<IllegalArgumentException> {
            PluginSettingDefinition("length", PluginSettingType.NUMBER, "Length", JsonPrimitive(0), min = 1.0).validate()
        }
        assertFailsWith<IllegalArgumentException> {
            PluginSettingDefinition("length", PluginSettingType.NUMBER, "Length", JsonPrimitive("8")).validate()
        }
        assertFailsWith<IllegalArgumentException> {
            PluginSettingDefinition(
                "charset",
                PluginSettingType.SELECT,
                "Characters",
                JsonPrimitive("other"),
                options = listOf(PluginSettingOption("alnum", "Letters and numbers")),
            ).validate()
        }
        assertFailsWith<IllegalArgumentException> {
            listOf(
                PluginSettingDefinition("same", PluginSettingType.TEXT, "First", JsonPrimitive("a")),
                PluginSettingDefinition("same", PluginSettingType.TEXT, "Second", JsonPrimitive("b")),
            ).validatePluginSettings()
        }
    }

    @Test
    fun `accepts enforces types and numeric ranges`() {
        val setting = PluginSettingDefinition(
            "length",
            PluginSettingType.NUMBER,
            "Length",
            JsonPrimitive(8),
            min = 1.0,
            max = 64.0,
        )

        assertTrue(setting.accepts(JsonPrimitive(12)))
        assertFalse(setting.accepts(JsonPrimitive(0)))
        assertFalse(setting.accepts(JsonPrimitive("12")))
    }

    private fun parse(json: String) = ValencedJson.decodeFromString<List<PluginSettingDefinition>>(json)

    @Test
    fun `schema additions parse and validate`() {
        val settings = parse(
            """
            [
              { "key": "enabled", "type": "switch", "label": "Show counter", "default": true },
              { "key": "position", "type": "select", "label": "Position", "default": "right",
                "options": [{ "value": "left", "label": "Left" }, { "value": "right", "label": "Right" }],
                "showIf": { "key": "enabled", "equals": true } },
              { "key": "prefix", "type": "text", "label": "Prefix", "default": "#",
                "minLength": 1, "maxLength": 4, "pattern": "^[#!]+${'$'}" },
              { "key": "size", "type": "number", "label": "Size", "default": 8, "min": 1, "max": 64, "integer": true },
              { "key": "accent", "type": "color", "label": "Accent", "default": "#5865F2" },
              { "key": "words", "type": "list", "label": "Blocked words", "item": "text", "default": [], "maxItems": 2 },
              { "key": "limits", "type": "object", "label": "Limits", "settings": [
                  { "key": "soft", "type": "number", "label": "Soft limit", "default": 1800 },
                  { "key": "hard", "type": "number", "label": "Hard limit", "default": 2000 }
              ] }
            ]
            """,
        )
        settings.validatePluginSettings()

        assertEquals(
            JsonObject(mapOf("soft" to JsonPrimitive(1800), "hard" to JsonPrimitive(2000))),
            settings.findSetting("limits")!!.defaultValue,
        )
        assertEquals("soft", settings.findSetting("limits.soft")?.key)
        assertNull(settings.findSetting("size.soft"))
        assertNull(settings.findSetting("limits.soft.x"))

        val invalid = listOf(
            """[{ "key": "a.b", "type": "switch", "label": "A", "default": true }]""",
            """[{ "key": "a", "type": "switch", "label": "A", "default": true, "showIf": { "key": "a", "equals": true } }]""",
            """[{ "key": "a", "type": "switch", "label": "A", "default": true, "showIf": { "key": "b", "equals": true } }]""",
            """[{ "key": "a", "type": "switch", "label": "A", "default": true },
               { "key": "b", "type": "switch", "label": "B", "default": true, "showIf": { "key": "a", "equals": "x" } }]""",
            """[{ "key": "a", "type": "text", "label": "A", "default": "", "minLength": 1 }]""",
            """[{ "key": "a", "type": "text", "label": "A", "default": "a", "pattern": "(" }]""",
            """[{ "key": "a", "type": "text", "label": "A", "default": "a", "minLength": 3, "maxLength": 2 }]""",
            """[{ "key": "a", "type": "switch", "label": "A", "default": true, "pattern": "a" }]""",
            """[{ "key": "a", "type": "number", "label": "A", "default": 1.5, "integer": true }]""",
            """[{ "key": "a", "type": "text", "label": "A", "default": "a", "integer": true }]""",
            """[{ "key": "a", "type": "color", "label": "A", "default": "#12345" }]""",
            """[{ "key": "a", "type": "color", "label": "A", "default": "red" }]""",
            """[{ "key": "a", "type": "list", "label": "A", "item": "switch", "default": [] }]""",
            """[{ "key": "a", "type": "list", "label": "A", "default": [] }]""",
            """[{ "key": "a", "type": "list", "label": "A", "item": "text", "default": "" }]""",
            """[{ "key": "a", "type": "list", "label": "A", "item": "text", "default": ["a", "b"], "maxItems": 1 }]""",
            """[{ "key": "a", "type": "list", "label": "A", "item": "number", "default": [0], "min": 1 }]""",
            """[{ "key": "a", "type": "text", "label": "A", "default": "", "item": "text" }]""",
            """[{ "key": "a", "type": "object", "label": "A", "settings": [] }]""",
            """[{ "key": "a", "type": "object", "label": "A", "default": {}, "settings": [
                { "key": "b", "type": "switch", "label": "B", "default": true }] }]""",
            """[{ "key": "a", "type": "object", "label": "A", "settings": [
                { "key": "b", "type": "object", "label": "B", "settings": [
                  { "key": "c", "type": "switch", "label": "C", "default": true }] }] }]""",
            """[{ "key": "a", "type": "object", "label": "A", "settings": [
                { "key": "b", "type": "switch", "label": "B", "default": true, "showIf": { "key": "c", "equals": true } }] }]""",
            """[{ "key": "a", "type": "switch", "label": "A", "default": true, "settings": [
                { "key": "b", "type": "switch", "label": "B", "default": true }] }]""",
        )
        for (json in invalid) assertFailsWith<IllegalArgumentException>(json) { parse(json).validatePluginSettings() }
    }

    @Test
    fun `accepts enforces the new value rules`() {
        val settings = parse(
            """
            [
              { "key": "prefix", "type": "text", "label": "Prefix", "default": "#",
                "minLength": 1, "maxLength": 4, "pattern": "^[#!]+${'$'}" },
              { "key": "size", "type": "number", "label": "Size", "default": 8, "integer": true },
              { "key": "accent", "type": "color", "label": "Accent", "default": "#5865F2" },
              { "key": "ids", "type": "list", "label": "IDs", "item": "number", "default": [1], "maxItems": 2, "min": 0 },
              { "key": "limits", "type": "object", "label": "Limits", "settings": [
                  { "key": "soft", "type": "number", "label": "Soft limit", "default": 1800 }
              ] }
            ]
            """,
        ).associateBy { it.key }

        val prefix = settings.getValue("prefix")
        assertTrue(prefix.accepts(JsonPrimitive("#!")))
        assertFalse(prefix.accepts(JsonPrimitive("")))
        assertFalse(prefix.accepts(JsonPrimitive("#####")))
        assertFalse(prefix.accepts(JsonPrimitive("#a")))

        val size = settings.getValue("size")
        assertTrue(size.accepts(JsonPrimitive(3)))
        assertTrue(size.accepts(JsonPrimitive(3.0)))
        assertFalse(size.accepts(JsonPrimitive(3.5)))

        val accent = settings.getValue("accent")
        assertTrue(accent.accepts(JsonPrimitive("#80ffffff")))
        assertFalse(accent.accepts(JsonPrimitive("#fff")))
        assertFalse(accent.accepts(JsonPrimitive("#gggggg")))

        val ids = settings.getValue("ids")
        assertTrue(ids.accepts(JsonArray(listOf(JsonPrimitive(1), JsonPrimitive(2)))))
        assertFalse(ids.accepts(JsonArray(listOf(JsonPrimitive(1), JsonPrimitive(2), JsonPrimitive(3)))))
        assertFalse(ids.accepts(JsonArray(listOf(JsonPrimitive(-1)))))
        assertFalse(ids.accepts(JsonArray(listOf(JsonPrimitive("1")))))
        assertFalse(ids.accepts(JsonPrimitive(1)))

        val limits = settings.getValue("limits")
        assertTrue(limits.accepts(JsonObject(mapOf("soft" to JsonPrimitive(5)))))
        assertFalse(limits.accepts(JsonObject(mapOf("soft" to JsonPrimitive("5")))))
        assertFalse(limits.accepts(JsonObject(mapOf("other" to JsonPrimitive(5)))))
    }
}

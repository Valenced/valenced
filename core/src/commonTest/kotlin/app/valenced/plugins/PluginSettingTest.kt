package app.valenced.plugins

import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
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
}

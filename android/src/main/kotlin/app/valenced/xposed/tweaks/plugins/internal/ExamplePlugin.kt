package app.valenced.xposed.tweaks.plugins.internal

import app.valenced.plugins.API_VERSION
import app.valenced.plugins.PluginManifest
import app.valenced.plugins.PluginSettingCondition
import app.valenced.plugins.PluginSettingDefinition
import app.valenced.plugins.PluginSettingType
import app.valenced.xposed.api.registerNativeMethod
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

private val manifest = PluginManifest(
    id = "valenced.example",
    name = "Example Plugin",
    description = "Example plugin.",
    author = "Valenced",
    settings = listOf(
        PluginSettingDefinition(
            key = "greeting",
            type = PluginSettingType.TEXT,
            label = "Greeting",
            default = JsonPrimitive("Hello"),
        ),
        PluginSettingDefinition(
            key = "enabled",
            type = PluginSettingType.SWITCH,
            label = "Show greeting",
            default = JsonPrimitive(true),
        ),
        PluginSettingDefinition(
            key = "prefix",
            type = PluginSettingType.TEXT,
            label = "Prefix",
            default = JsonPrimitive("#"),
            showIf = PluginSettingCondition("enabled", JsonPrimitive(true)),
            minLength = 1,
            maxLength = 4,
            pattern = "^[#!]+$",
        ),
        PluginSettingDefinition(
            key = "size",
            type = PluginSettingType.NUMBER,
            label = "Size",
            default = JsonPrimitive(8),
            min = 1.0,
            max = 64.0,
            integer = true,
        ),
        PluginSettingDefinition(
            key = "accent",
            type = PluginSettingType.COLOR,
            label = "Accent",
            default = JsonPrimitive("#5865F2"),
        ),
        PluginSettingDefinition(
            key = "words",
            type = PluginSettingType.LIST,
            label = "Blocked words",
            default = JsonArray(emptyList()),
            item = PluginSettingType.TEXT,
            maxItems = 50,
        ),
        PluginSettingDefinition(
            key = "limits",
            type = PluginSettingType.OBJECT,
            label = "Limits",
            settings = listOf(
                PluginSettingDefinition(
                    key = "soft",
                    type = PluginSettingType.NUMBER,
                    label = "Soft limit",
                    default = JsonPrimitive(1800),
                ),
                PluginSettingDefinition(
                    key = "hard",
                    type = PluginSettingType.NUMBER,
                    label = "Hard limit",
                    default = JsonPrimitive(2000),
                ),
            ),
        ),
    ),
    version = API_VERSION,
)

internal val examplePlugin =
    internalPlugin(manifest, setOf(InternalPluginFlags.INTERNAL)) {
        start {
            log.i("started in ${appInfo.packageName}, greeting: ${settings.get("greeting")}")
            registerNativeMethod("valenced.example.test") { args ->
                log.i("valenced.example.test($args)")
                null
            }

            registerNativeMethod("valenced.example.test.error") {
                errors.tryEmit(Exception("Test exception!"))
            }
        }
    }

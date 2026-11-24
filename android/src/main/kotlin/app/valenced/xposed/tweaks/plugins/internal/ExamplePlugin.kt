package app.valenced.xposed.tweaks.plugins.internal

import app.valenced.plugins.API_VERSION
import app.valenced.plugins.PluginManifest
import app.valenced.plugins.PluginSettingDefinition
import app.valenced.plugins.PluginSettingType
import app.valenced.xposed.api.registerNativeMethod
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

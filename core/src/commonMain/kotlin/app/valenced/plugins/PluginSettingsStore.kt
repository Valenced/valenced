package app.valenced.plugins

import app.valenced.core.ValencedJson
import app.valenced.core.Lock
import app.valenced.core.atomicWriteUtf8
import app.valenced.core.readUtf8OrNull
import app.valenced.plugins.external.requireValidPluginId
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okio.Path

/** Stores client-shared settings in `settings/<plugin-id>.json`. */
object PluginSettingsStore {
    private val lock = Lock()

    fun read(paths: PluginPaths, pluginId: String, settings: List<PluginSettingDefinition>): JsonObject {
        return lock.withLock {
            settings.validatePluginSettings()
            val file = file(paths, pluginId)
            val stored = readStored(paths, file)
            JsonObject(settings.associate { definition ->
                val value = stored[definition.key]?.takeIf(definition::accepts) ?: definition.default
                definition.key to value
            })
        }
    }

    fun write(
        paths: PluginPaths,
        pluginId: String,
        settings: List<PluginSettingDefinition>,
        key: String,
        value: JsonElement,
    ) {
        lock.withLock {
            settings.validatePluginSettings()
            val definition = settings.firstOrNull { it.key == key }
                ?: throw PluginSystemError(PluginErrorCodes.INVALID_ARGUMENT, "Unknown setting '$key' for '$pluginId'")
            if (!definition.accepts(value))
                throw PluginSystemError(PluginErrorCodes.INVALID_ARGUMENT, "Invalid value for setting '$key'")

            val file = file(paths, pluginId)
            val definitions = settings.associateBy { it.key }
            val stored = readStored(paths, file).filterKeys(definitions::containsKey)
                .filter { (storedKey, storedValue) -> definitions.getValue(storedKey).accepts(storedValue) }
                .toMutableMap()
            stored[key] = value

            try {
                paths.fs.createDirectories(paths.settings)
                paths.fs.atomicWriteUtf8(file, ValencedJson.encodeToString(JsonObject(stored)))
            } catch (t: Throwable) {
                throw PluginSystemError(PluginErrorCodes.STORAGE_FAILED, "Failed to save settings for '$pluginId'", t)
            }
        }
    }

    fun delete(paths: PluginPaths, pluginId: String) {
        lock.withLock {
            val file = file(paths, pluginId)
            runCatching { paths.fs.delete(file, mustExist = false) }.getOrElse {
                throw PluginSystemError(PluginErrorCodes.STORAGE_FAILED, "Failed to delete settings for '$pluginId'", it)
            }
        }
    }

    private fun file(paths: PluginPaths, pluginId: String): Path {
        requireValidPluginId(pluginId)
        return paths.settingsFile(pluginId)
    }

    private fun readStored(paths: PluginPaths, file: Path): JsonObject {
        val text = paths.fs.readUtf8OrNull(file)?.takeIf { it.isNotEmpty() } ?: return JsonObject(emptyMap())
        return try {
            ValencedJson.decodeFromString<JsonObject>(text)
        } catch (t: Throwable) {
            throw PluginSystemError(PluginErrorCodes.STORAGE_FAILED, "Failed to read plugin settings: ${file.name}", t)
        }
    }
}

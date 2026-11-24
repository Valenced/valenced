package app.valenced.plugins

import app.valenced.core.ValencedJson
import app.valenced.core.Lock
import app.valenced.core.atomicWriteUtf8
import app.valenced.core.readUtf8OrNull
import app.valenced.plugins.external.requireValidPluginId
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okio.Path

object PluginSettingsStore {
    private val lock = Lock()

    fun read(paths: PluginPaths, pluginId: String, settings: List<PluginSettingDefinition>): JsonObject {
        return lock.withLock {
            settings.validatePluginSettings()
            val stored = readStored(paths, pluginId, settings)
            JsonObject(settings.associate { definition ->
                val value = stored[definition.key]
                definition.key to when (value) {
                    is JsonObject -> JsonObject(definition.defaultValue as JsonObject + value)
                    else -> value ?: definition.defaultValue
                }
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
            val definition = settings.findSetting(key)
                ?: throw PluginSystemError(PluginErrorCodes.INVALID_ARGUMENT, "Unknown setting '$key' for '$pluginId'")
            if (!definition.accepts(value))
                throw PluginSystemError(PluginErrorCodes.INVALID_ARGUMENT, "Invalid value for setting '$key'")

            val stored = readStored(paths, pluginId, settings).toMutableMap()
            val parent = key.substringBefore('.')
            stored[parent] = if (parent == key) value else
                JsonObject((stored[parent] as? JsonObject).orEmpty() + (key.substringAfter('.') to value))
            save(paths, pluginId, JsonObject(stored))
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

    /** Resets values to defaults without repeating the `storage.json` migration. */
    fun clear(paths: PluginPaths, pluginId: String, settings: List<PluginSettingDefinition>) {
        lock.withLock {
            if (settings.isNotEmpty()) save(paths, pluginId, JsonObject(emptyMap()))
        }
    }

    private fun file(paths: PluginPaths, pluginId: String): Path {
        requireValidPluginId(pluginId)
        return paths.settingsFile(pluginId)
    }

    private fun save(paths: PluginPaths, pluginId: String, values: JsonObject) {
        val file = file(paths, pluginId)
        try {
            paths.fs.createDirectories(paths.settings)
            paths.fs.atomicWriteUtf8(file, ValencedJson.encodeToString(values))
        } catch (t: Throwable) {
            throw PluginSystemError(PluginErrorCodes.STORAGE_FAILED, "Failed to save settings for '$pluginId'", t)
        }
    }

    private fun readStored(paths: PluginPaths, pluginId: String, settings: List<PluginSettingDefinition>): JsonObject {
        val file = file(paths, pluginId)
        if (!paths.fs.exists(file)) {
            if (settings.isEmpty()) return JsonObject(emptyMap())
            val legacy = paths.storageFor(PluginStatesStore.activeSlotId) / pluginId / "storage.json"
            val migrated = paths.fs.readUtf8OrNull(legacy)
                ?.let { runCatching { ValencedJson.decodeFromString<JsonObject>(it) }.getOrNull() }
                ?.let { valid(settings, it) } ?: JsonObject(emptyMap())
            save(paths, pluginId, migrated)
            return migrated
        }
        val text = paths.fs.readUtf8OrNull(file)?.takeIf { it.isNotEmpty() } ?: return JsonObject(emptyMap())
        return try {
            valid(settings, ValencedJson.decodeFromString<JsonObject>(text))
        } catch (t: Throwable) {
            throw PluginSystemError(PluginErrorCodes.STORAGE_FAILED, "Failed to read plugin settings: ${file.name}", t)
        }
    }

    private fun valid(settings: List<PluginSettingDefinition>, stored: JsonObject): JsonObject =
        JsonObject(settings.mapNotNull { definition ->
            val value = stored[definition.key] ?: return@mapNotNull null
            when {
                definition.type == PluginSettingType.OBJECT ->
                    (value as? JsonObject)?.let { definition.key to valid(definition.settings, it) }
                definition.accepts(value) -> definition.key to value
                else -> null
            }
        }.toMap())
}

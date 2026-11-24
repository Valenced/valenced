package app.valenced.xposed.phoenix

import app.valenced.xposed.ValencedJson
import app.valenced.xposed.tweaks.bridge.ValencedBridgeRegistry
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

internal fun encodeJson(value: Any?): String = ValencedJson.encodeToString(JsonElement.serializer(), toJson(value))

internal fun decodeCall(payload: String): Pair<String, List<Any?>>? {
    val root = runCatching { ValencedJson.parseToJsonElement(payload) }.getOrNull() as? JsonObject ?: return null
    val call = root[ValencedBridgeRegistry.NATIVE_CALL_DATA_KEY] as? JsonObject ?: return null

    val name = (call[ValencedBridgeRegistry.NATIVE_METHOD_NAME_KEY] as? JsonPrimitive)
        ?.takeIf { it.isString }?.content ?: return null
    val args = call[ValencedBridgeRegistry.NATIVE_METHOD_ARGS_KEY] as? JsonArray ?: return null

    return name to args.map(::fromJson)
}

internal fun toJson(value: Any?): JsonElement = when (value) {
    null, Unit -> JsonNull
    is JsonElement -> value
    is String -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is Map<*, *> -> JsonObject(value.entries.associate { it.key.toString() to toJson(it.value) })
    is Iterable<*> -> JsonArray(value.map(::toJson))
    is Array<*> -> JsonArray(value.map(::toJson))
    is ByteArray -> JsonArray(value.map { JsonPrimitive(it) })
    else -> JsonPrimitive(value.toString())
}

private fun fromJson(element: JsonElement): Any? = when (element) {
    is JsonNull -> null
    is JsonPrimitive ->
        if (element.isString) element.content
        else element.booleanOrNull ?: element.longOrNull ?: element.doubleOrNull ?: element.content
    is JsonArray -> element.map(::fromJson)
    is JsonObject -> element.mapValues { fromJson(it.value) }
}

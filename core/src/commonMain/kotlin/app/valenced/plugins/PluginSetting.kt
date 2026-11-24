package app.valenced.plugins

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

@Serializable
enum class PluginSettingType {
    @SerialName("switch") SWITCH,
    @SerialName("text") TEXT,
    @SerialName("number") NUMBER,
    @SerialName("select") SELECT,
    @SerialName("color") COLOR,
    @SerialName("list") LIST,
    @SerialName("object") OBJECT,
}

@Serializable
data class PluginSettingOption(
    val value: String,
    val label: String,
)

@Serializable
data class PluginSettingCondition(
    val key: String,
    val equals: JsonElement,
)

private val colorPattern = Regex("^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")

@Serializable
data class PluginSettingDefinition(
    val key: String,
    val type: PluginSettingType,
    val label: String,
    val default: JsonElement = JsonNull,
    val description: String? = null,
    val section: String? = null,
    val min: Double? = null,
    val max: Double? = null,
    val options: List<PluginSettingOption> = emptyList(),
    val showIf: PluginSettingCondition? = null,
    val minLength: Int? = null,
    val maxLength: Int? = null,
    val pattern: String? = null,
    val integer: Boolean = false,
    val item: PluginSettingType? = null,
    val maxItems: Int? = null,
    val settings: List<PluginSettingDefinition> = emptyList(),
) {
    private val regex by lazy { pattern?.let(::Regex) }

    val defaultValue: JsonElement
        get() = if (type == PluginSettingType.OBJECT) JsonObject(settings.associate { it.key to it.default }) else default

    fun validate() {
        val primitive = default as? JsonPrimitive
        require(key.isNotBlank()) { "Setting key must not be blank" }
        require('.' !in key) { "Setting '$key' key must not contain dots" }
        require(label.isNotBlank()) { "Setting '$key' label must not be blank" }
        require(description == null || description.isNotBlank()) { "Setting '$key' description must not be blank" }
        require(section == null || section.isNotBlank()) { "Setting '$key' section must not be blank" }

        val textRules = type == PluginSettingType.TEXT || (type == PluginSettingType.LIST && item == PluginSettingType.TEXT)
        val numberRules = type == PluginSettingType.NUMBER || (type == PluginSettingType.LIST && item == PluginSettingType.NUMBER)
        require(textRules || (minLength == null && maxLength == null && pattern == null)) {
            "Setting '$key' minLength, maxLength and pattern require text type"
        }
        require(numberRules || !integer) { "Setting '$key' integer requires number type" }
        require(minLength == null || minLength >= 0) { "Setting '$key' minLength must not be negative" }
        require(minLength == null || maxLength == null || minLength <= maxLength) {
            "Setting '$key' minLength must not exceed maxLength"
        }
        require(runCatching { regex }.isSuccess) { "Setting '$key' pattern must be a valid regex" }
        require(item == null || type == PluginSettingType.LIST) { "Setting '$key' item requires list type" }
        require(maxItems == null || type == PluginSettingType.LIST) { "Setting '$key' maxItems requires list type" }
        require(settings.isEmpty() || type == PluginSettingType.OBJECT) { "Setting '$key' settings require object type" }

        when (type) {
            PluginSettingType.SWITCH -> require(primitive?.booleanOrNull != null) {
                "Setting '$key' default must be a boolean"
            }
            PluginSettingType.TEXT -> {
                require(primitive?.isString == true) { "Setting '$key' default must be a string" }
                require(accepts(type, primitive)) { "Setting '$key' default does not match its constraints" }
            }
            PluginSettingType.NUMBER -> {
                val value = primitive?.takeUnless { it.isString }?.doubleOrNull
                require(value != null && value.isFinite()) { "Setting '$key' default must be a finite number" }
                require(min == null || min.isFinite()) { "Setting '$key' min must be finite" }
                require(max == null || max.isFinite()) { "Setting '$key' max must be finite" }
                require(min == null || max == null || min <= max) { "Setting '$key' min must not exceed max" }
                require(min == null || value >= min) { "Setting '$key' default is below min" }
                require(max == null || value <= max) { "Setting '$key' default is above max" }
                require(!integer || value % 1.0 == 0.0) { "Setting '$key' default must be an integer" }
                require(options.isEmpty()) { "Setting '$key' number cannot have options" }
            }
            PluginSettingType.SELECT -> {
                require(primitive?.isString == true) { "Setting '$key' default must be a string" }
                require(options.isNotEmpty()) { "Setting '$key' select must have options" }
                require(options.all { it.value.isNotBlank() }) { "Setting '$key' option values must not be blank" }
                require(options.all { it.label.isNotBlank() }) { "Setting '$key' option labels must not be blank" }
                require(options.map { it.value }.distinct().size == options.size) { "Setting '$key' option values must be unique" }
                require(options.any { it.value == primitive.content }) { "Setting '$key' default must match an option" }
                require(min == null && max == null) { "Setting '$key' select cannot have min or max" }
            }
            PluginSettingType.COLOR -> require(primitive != null && accepts(type, primitive)) {
                "Setting '$key' default must be a #RRGGBB or #AARRGGBB color"
            }
            PluginSettingType.LIST -> {
                require(item == PluginSettingType.TEXT || item == PluginSettingType.NUMBER) {
                    "Setting '$key' item must be text or number"
                }
                require(maxItems == null || maxItems >= 0) { "Setting '$key' maxItems must not be negative" }
                require(min == null || max == null || min <= max) { "Setting '$key' min must not exceed max" }
                require(default is JsonArray) { "Setting '$key' default must be an array" }
                require(accepts(default)) { "Setting '$key' default does not match its constraints" }
            }
            PluginSettingType.OBJECT -> {
                require(default is JsonNull) { "Setting '$key' object cannot have a default" }
                require(settings.isNotEmpty()) { "Setting '$key' object must have settings" }
                require(settings.none { it.type == PluginSettingType.OBJECT }) { "Setting '$key' objects cannot nest" }
                settings.validatePluginSettings()
            }
        }

        if (type != PluginSettingType.NUMBER) {
            require(numberRules || (min == null && max == null)) { "Setting '$key' min and max require number type" }
            require(options.isEmpty() || type == PluginSettingType.SELECT) {
                "Setting '$key' options require select type"
            }
        }
    }

    fun accepts(value: JsonElement): Boolean = when (type) {
        PluginSettingType.LIST -> value is JsonArray && (maxItems == null || value.size <= maxItems) &&
            item != null && value.all { accepts(item, it) }
        PluginSettingType.OBJECT -> value is JsonObject && value.all { (childKey, childValue) ->
            settings.firstOrNull { it.key == childKey }?.accepts(childValue) == true
        }
        else -> accepts(type, value)
    }

    private fun accepts(type: PluginSettingType, value: JsonElement): Boolean {
        val primitive = value as? JsonPrimitive
        return when (type) {
            PluginSettingType.SWITCH -> primitive?.booleanOrNull != null
            PluginSettingType.TEXT -> primitive?.isString == true &&
                (minLength == null || primitive.content.length >= minLength) &&
                (maxLength == null || primitive.content.length <= maxLength) &&
                regex?.containsMatchIn(primitive.content) != false
            PluginSettingType.NUMBER -> primitive?.takeUnless { it.isString }?.doubleOrNull?.let { number ->
                number.isFinite() && (min == null || number >= min) && (max == null || number <= max) &&
                    (!integer || number % 1.0 == 0.0)
            } == true
            PluginSettingType.SELECT -> primitive?.isString == true && options.any { it.value == primitive.content }
            PluginSettingType.COLOR -> primitive?.isString == true && colorPattern.matches(primitive.content)
            PluginSettingType.LIST, PluginSettingType.OBJECT -> false
        }
    }
}

fun List<PluginSettingDefinition>.validatePluginSettings() {
    require(map { it.key }.distinct().size == size) { "Setting keys must be unique" }
    forEach(PluginSettingDefinition::validate)
    forEach { setting ->
        val condition = setting.showIf ?: return@forEach
        require(condition.key != setting.key) { "Setting '${setting.key}' showIf cannot name itself" }
        val sibling = firstOrNull { it.key == condition.key }
        require(sibling != null) { "Setting '${setting.key}' showIf names missing setting '${condition.key}'" }
        require(sibling.accepts(condition.equals)) {
            "Setting '${setting.key}' showIf value is not valid for '${condition.key}'"
        }
    }
}

fun List<PluginSettingDefinition>.findSetting(path: String): PluginSettingDefinition? {
    val parts = path.split('.')
    val setting = firstOrNull { it.key == parts[0] }
    return when (parts.size) {
        1 -> setting
        2 -> setting?.takeIf { it.type == PluginSettingType.OBJECT }?.settings?.firstOrNull { it.key == parts[1] }
        else -> null
    }
}

fun JsonObject.settingAt(path: String): JsonElement? =
    path.split('.').fold<String, JsonElement?>(this) { value, key -> (value as? JsonObject)?.get(key) }

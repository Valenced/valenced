package app.valenced.plugins

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

@Serializable
enum class PluginSettingType {
    @SerialName("switch") SWITCH,
    @SerialName("text") TEXT,
    @SerialName("number") NUMBER,
    @SerialName("select") SELECT,
}

@Serializable
data class PluginSettingOption(
    val value: String,
    val label: String,
)

@Serializable
data class PluginSettingDefinition(
    val key: String,
    val type: PluginSettingType,
    val label: String,
    val default: JsonElement,
    val description: String? = null,
    val section: String? = null,
    val min: Double? = null,
    val max: Double? = null,
    val options: List<PluginSettingOption> = emptyList(),
) {
    fun validate() {
        val primitive = default as? JsonPrimitive
        require(key.isNotBlank()) { "Setting key must not be blank" }
        require(label.isNotBlank()) { "Setting '$key' label must not be blank" }
        require(description == null || description.isNotBlank()) { "Setting '$key' description must not be blank" }
        require(section == null || section.isNotBlank()) { "Setting '$key' section must not be blank" }

        when (type) {
            PluginSettingType.SWITCH -> require(primitive?.booleanOrNull != null) {
                "Setting '$key' default must be a boolean"
            }
            PluginSettingType.TEXT -> require(primitive?.isString == true) {
                "Setting '$key' default must be a string"
            }
            PluginSettingType.NUMBER -> {
                val value = primitive?.takeUnless { it.isString }?.doubleOrNull
                require(value != null && value.isFinite()) { "Setting '$key' default must be a finite number" }
                require(min == null || min.isFinite()) { "Setting '$key' min must be finite" }
                require(max == null || max.isFinite()) { "Setting '$key' max must be finite" }
                require(min == null || max == null || min <= max) { "Setting '$key' min must not exceed max" }
                require(min == null || value >= min) { "Setting '$key' default is below min" }
                require(max == null || value <= max) { "Setting '$key' default is above max" }
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
        }

        if (type != PluginSettingType.NUMBER) {
            require(min == null && max == null) { "Setting '$key' min and max require number type" }
            require(options.isEmpty() || type == PluginSettingType.SELECT) {
                "Setting '$key' options require select type"
            }
        }
    }

    fun accepts(value: JsonElement): Boolean {
        val primitive = value as? JsonPrimitive
        return when (type) {
            PluginSettingType.SWITCH -> primitive?.booleanOrNull != null
            PluginSettingType.TEXT -> primitive?.isString == true
            PluginSettingType.NUMBER -> primitive?.takeUnless { it.isString }?.doubleOrNull?.let { number ->
                number.isFinite() && (min == null || number >= min) && (max == null || number <= max)
            } == true
            PluginSettingType.SELECT -> primitive?.isString == true && options.any { it.value == primitive.content }
        }
    }
}

fun List<PluginSettingDefinition>.validatePluginSettings() {
    require(map { it.key }.distinct().size == size) { "Setting keys must be unique" }
    forEach(PluginSettingDefinition::validate)
}

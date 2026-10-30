package app.valenced.plugins

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonPrimitive

/**
 * Contributor as written in manifests: `{ "name": "...", "id"?: "<DISCORD_ID>", "links"?: [{ "url": "...", "title"?: "..." }] }`.
 * Preferred over the legacy `Name <DISCORD_ID> (LINK "TITLE")` string, which is still accepted.
 *
 * Decoded into the string form of [PluginManifest.author].
 */
@Serializable
internal data class ContributorObject(
    val name: String,
    /** Discord user ID. */
    val id: String? = null,
    val links: List<Link> = emptyList(),
) {
    @Serializable
    data class Link(val url: String, val title: String? = null)

    fun format() = buildString {
        append(name.trim())
        if (id != null) append(" <").append(id).append('>')
        for ((url, title) in links) {
            append(" (").append(url)
            if (title != null) append(" \"").append(title).append('"')
            append(')')
        }
    }
}

/** Accepts a [ContributorObject] or a legacy contributor string, always decoding to the string form. */
object ContributorSerializer : KSerializer<String> {
    override val descriptor = PrimitiveSerialDescriptor("app.valenced.plugins.Contributor", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: String) = encoder.encodeString(value)

    override fun deserialize(decoder: Decoder): String {
        if (decoder !is JsonDecoder) return decoder.decodeString()

        val element = decoder.decodeJsonElement()
        if (element is JsonPrimitive && element.isString) return element.content
        return decoder.json.decodeFromJsonElement(ContributorObject.serializer(), element).format()
    }
}

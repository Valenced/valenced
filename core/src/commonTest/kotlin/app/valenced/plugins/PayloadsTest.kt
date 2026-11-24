package app.valenced.plugins

import app.valenced.core.ValencedJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private fun encode(payload: PluginPayload) = ValencedJson.encodeToJsonElement(payload) as JsonObject

private val manifest = PluginManifest(
    id = "a.b",
    name = "A",
    description = "",
    author = "",
    icon = null,
    version = Version.parse("1.0.0"),
)

private val payload = PluginPayload(
    manifest = manifest.toPayload(),
    script = null,
    internal = false,
    essential = false,
    enabledByDefault = false,
    api = false,
    source = null,
    hasStub = false,
)

/** The wire shape is a contract with valenced-next: keys never silently appear or disappear. */
class PayloadsTest {
    @Test
    fun `a plugin entry always carries its keys`() {
        val json = encode(payload)

        assertEquals(
            setOf(
                "manifest", "script", "internal", "essential", "enabledByDefault", "api", "source",
                "hasStub", "unsatisfiedOptionalDependencies", "errors",
            ),
            json.keys,
        )
        assertEquals(MANIFEST_FORMAT_JSON, (json["manifest"] as JsonObject)["format"].toString())
    }

    @Test
    fun `failed only shows up on a discovery failure`() {
        assertFalse("failed" in encode(payload))
        assertTrue("failed" in encode(payload.copy(failed = true)))
    }

    @Test
    fun `compat only shows up on a compat plugin`() {
        assertFalse("compat" in encode(payload))
        assertTrue("compat" in encode(payload.copy(compat = true)))
    }

    @Test
    fun `an error keeps stack and drops absent details`() {
        val json = ValencedJson.encodeToJsonElement(PluginError(PluginErrorCodes.LOAD_FAILED, "boom")) as JsonObject

        assertEquals(setOf("code", "message", "stack"), json.keys)
    }
}

private const val MANIFEST_FORMAT_JSON = "1"

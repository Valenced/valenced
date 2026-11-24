package app.valenced.xposed.tweaks.plugins

import app.valenced.bridge.asDelegate
import app.valenced.plugins.PluginFlags
import app.valenced.plugins.PluginStateSlot
import app.valenced.plugins.PluginStatesStore
import app.valenced.plugins.pluginFlagsFromJSPayload
import app.valenced.plugins.toJSPayload
import app.valenced.xposed.api.HostScope
import app.valenced.xposed.tweak

/**
 * `valenced.plugins.states.*` bridge methods.
 *
 * A slot is a named set of plugin flags:
 * - [PluginStatesStore.activeSlotId]: the slot the user chose. The UI reads and edits it.
 * - [PluginStatesStore.bootSlotId]: the slot this boot runs on. Plugin scopes read and write it.
 *
 * Both slot IDs are the same on a normal boot.
 * A defaults boot resolves [PluginStatesStore.bootSlotId] to [PluginStatesStore.DEFAULTS_SLOT].
 */
val pluginStates by tweak {
    val paths = pluginPaths(appInfo.dataDir)

    /** `states.read(): Record<slotId, Record<pluginId, PluginStates>>` */
    pluginSystemMethod("valenced.plugins.states.read") {
        PluginStatesStore.ensureLoaded(paths)
        PluginStatesStore.toJSPayload()
    }

    /** `states.getSlots(): { active, oneShot?, slots }` */
    pluginSystemMethod("valenced.plugins.states.getSlots") {
        PluginStatesStore.ensureLoaded(paths)
        buildMap {
            put("active", PluginStatesStore.activeSlotId)
            PluginStatesStore.oneShotSlotId?.let { put("oneShot", it) }
            put("slots", PluginStatesStore.persistentSlotIds(paths))
        }
    }

    /** `states.getRuntime(): { id, plugins }` for a client host starting JS plugins. */
    pluginSystemMethod("valenced.plugins.states.getRuntime") {
        PluginStatesStore.ensureLoaded(paths)
        val slot = PluginStatesStore.boot
        mapOf(
            "id" to slot.id,
            "plugins" to slot.snapshot().mapValues { (_, flags) -> flags.toJSPayload() },
        )
    }

    /**
     * `states.setActiveSlot(slot, oneShot?)`
     *
     * Applies on the next boot.
     */
    pluginSystemMethod("valenced.plugins.states.setActiveSlot") { args ->
        val argv = args.asDelegate()
        val slot by argv.string()
        val oneShot by argv.booleanOrNull()

        PluginStatesStore.setActiveSlot(paths, slot, oneShot == true)
        null
    }

    /**
     * `states.update(slot, id, PluginStates): PluginStates`
     *
     * JS reporting flags it changed.
     * Writes to the slot directly since we already return the new state here and won't need to wait for emit.
     */
    pluginSystemMethod("valenced.plugins.states.update") { args ->
        val argv = args.asDelegate()
        val slotId by argv.string()
        val pluginId by argv.string()
        val states by argv.hashMap()

        val newFlags = pluginFlagsFromJSPayload(states)
        PluginStatesStore.ensureLoaded(paths)
        PluginStatesStore.slot(slotId)?.write(pluginId, newFlags)
        newFlags.toJSPayload()
    }
}


/**
 * Writes a plugin's flags into [slot] and notifies JS with [sendStateToJS].
 *
 * Await this before a bridge method resolves. Otherwise JS receives after it already resumed and overwrites what it adopted.
 */
context(host: HostScope)
internal suspend fun writeSlotFlags(slot: PluginStateSlot, pluginId: String, flags: Set<PluginFlags>) {
    slot.write(pluginId, flags)
    // Some non-persisted flags can change, so send anyway.
    sendStateToJS(slot.id, pluginId, flags)
}

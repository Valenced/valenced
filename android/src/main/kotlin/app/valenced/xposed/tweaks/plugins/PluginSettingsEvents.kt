package app.valenced.xposed.tweaks.plugins

internal object pluginSettingsEvents {
    private val listeners = mutableMapOf<Pair<String, String>, MutableSet<(Any?) -> Unit>>()

    @Synchronized
    fun subscribe(pluginId: String, key: String, listener: (Any?) -> Unit): AutoCloseable {
        val entry = pluginId to key
        listeners.getOrPut(entry, ::linkedSetOf).add(listener)
        return AutoCloseable {
            synchronized(this) {
                listeners[entry]?.let {
                    it.remove(listener)
                    if (it.isEmpty()) listeners.remove(entry)
                }
            }
        }
    }

    fun emit(pluginId: String, key: String, value: Any?) {
        val callbacks = synchronized(this) { listeners[pluginId to key]?.toList().orEmpty() }
        callbacks.forEach { runCatching { it(value) } }
    }
}

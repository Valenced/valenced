package app.valenced.plugins

/** Reads and updates manifest-declared plugin settings. */
interface PluginSettings {
    fun get(key: String): Any?

    fun set(key: String, value: Any?)

    fun subscribe(key: String, listener: (Any?) -> Unit): AutoCloseable
}

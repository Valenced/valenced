package app.valenced.xposed

object ValencedConstants {
    const val TARGET_PACKAGE = "com.discord"

    const val FILES_DIR = "files/valenced"
    const val CACHE_DIR = "cache/valenced"
    const val MAIN_SCRIPT_FILE = "bundle.js"
    const val BUNDLE_MANIFEST_FILE = "manifest.json"
    const val PRELOADS_DIR = "preloads"

    const val LOADER_NAME = "ValencedAndroid"
    val LOADER_VERSION
        get() = BuildConfig.VERSION_NAME
    val USER_AGENT
        get() = "ValencedAndroid/$LOADER_VERSION"

    /**
     * Hermes bundle shipped inside this APK's `assets/` directory, built by the `:bundle` project.
     * Loaded by [app.valenced.xposed.tweaks.valencedScriptLoader].
     */
    const val BUNDLE_ASSET = "assets://valenced.bundle"

    /**
     * Plain JS bundle for Discord's Phoenix client, built by the `:bundle` project and evaluated
     * by [app.valenced.xposed.phoenix.PhoenixRuntime]. Phoenix has no Hermes.
     */
    const val PHOENIX_BUNDLE_ASSET = "valenced.phoenix.bundle"

    /** The QuickJS host Valenced ships, built from `android/native`. */
    const val PHOENIX_LIBRARY = "valenced_phoenix"
}

/**
 * Hermes bytecode assets shipped inside the Xposed module APK.
 */
val scriptAssets = emptyList<String>()

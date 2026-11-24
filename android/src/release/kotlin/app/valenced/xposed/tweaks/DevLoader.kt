package app.valenced.xposed.tweaks

import app.valenced.xposed.tweak
import java.io.File

/**
 * Release builds only run the bundle shipped in the APK. They never download or load other scripts.
 * See the debug source set for the development loader.
 */
object DevLoader {
    fun awaitBundle(): File? = null

    fun awaitPhoenixBundle(): File? = null

    fun connectDevTools() {}

    fun readBundleManifest(): String? = null

    fun preloads(): List<File> = emptyList()

    val recoveryOptions: List<Pair<String, () -> Unit>> = emptyList()
}

val devLoader by tweak {}

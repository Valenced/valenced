package app.valenced.xposed.tweaks

import android.content.ContextWrapper
import app.valenced.xposed.Tweak
import app.valenced.xposed.ensureFile
import app.valenced.xposed.hook
import app.valenced.xposed.loadClassOrNull
import app.valenced.xposed.method
import app.valenced.xposed.methodHook
import app.valenced.xposed.api.registerNativeMethod
import app.valenced.xposed.tweak
import de.robv.android.xposed.XposedBridge
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

enum class PhoenixForce { FOLLOW, PHOENIX, RN }

/** Discord's choice at the last launch, or null before the decision runs. */
var phoenixLaunched: Boolean? = null
    private set

/** The loader setting [phoenixMode] read at startup. */
var phoenixForce = PhoenixForce.FOLLOW
    private set

private val decisionListeners = CopyOnWriteArrayList<(Boolean) -> Unit>()

/** Xposed framework hosting the module, with its API version. */
val xposedFramework by lazy {
    runCatching {
        val config = XposedBridge::class.java.classLoader!!.loadClass("org.lsposed.lspatch.share.LSPConfig")
        "LSPatch ${config.getField("VERSION_NAME").get(config.getField("instance").get(null))}"
    }.recoverCatching {
        (XposedBridge::class.java.getField("TAG").get(null) as String).removeSuffix("-Bridge")
    }.getOrDefault("Xposed") + " (API ${XposedBridge.getXposedVersion()})"
}

/**
 * Runs [block] with the launch choice once [phoenixMode] records it, or right away when the
 * decision already happened. Tweaks apply before Discord decides, so this is how a consumer waits.
 */
fun onLaunchDecision(block: (Boolean) -> Unit) {
    val decided = phoenixLaunched
    if (decided != null) block(decided)
    else decisionListeners += block
}

/**
 * Observes and optionally overrides Discord's React Native vs Phoenix launch choice.
 *
 * `PhoenixLaunch.i(ContextWrapper): Z` returns true to launch the native Phoenix client, false for
 * React Native. The method holds the "Phoenix didn't stay up for 3 launches" string. Forcing it is
 * read from `files/valenced/phoenix_mode`: `phoenix`, `rn` or `follow` (default).
 */
val phoenixMode by tweak {
    registerNativeMethod("valenced.client.info") {
        mapOf(
            "running" to if (phoenixLaunched == true) "phoenix" else "rn",
            "mode" to readForce(appInfo.dataDir).name.lowercase(),
            "framework" to xposedFramework,
        )
    }

    registerNativeMethod("valenced.client.setMode") { args ->
        val mode = args.firstOrNull() as? String
        require(mode != null && PhoenixForce.entries.any { it.name.equals(mode, ignoreCase = true) }) {
            "Unknown client mode: $mode"
        }
        File(appInfo.dataDir, "files/valenced/phoenix_mode").writeText(mode.lowercase())
        null
    }

    val cls = classLoader.loadClassOrNull("com.discord.phoenix_launch.PhoenixLaunch")
    if (cls == null) {
        log.i("No PhoenixLaunch, this build has no Phoenix client")
        publishLaunchDecision(false)
        return@tweak
    }

    val decide = try {
        cls.method("i", ContextWrapper::class.java)
    } catch (e: NoSuchMethodException) {
        log.e("PhoenixLaunch.i(ContextWrapper) not found, launch decision left to Discord", e)
        publishLaunchDecision(false)
        return@tweak
    }

    val force = readForce(appInfo.dataDir)
    phoenixForce = force
    log.i("Phoenix mode: ${force.name.lowercase()}")

    decide.hook(methodHook {
        before {
            when (force) {
                PhoenixForce.PHOENIX -> result = true
                PhoenixForce.RN -> result = false
                PhoenixForce.FOLLOW -> {}
            }
        }
        after {
            val launched = result as? Boolean
            publishLaunchDecision(launched == true)
        }
    }.build())
}

private fun Tweak.publishLaunchDecision(launched: Boolean) {
    if (phoenixLaunched != null) return
    phoenixLaunched = launched

    log.i("Launching ${if (launched) "Phoenix" else "React Native"}")
    for (listener in decisionListeners) {
        try {
            listener(launched)
        } catch (e: Throwable) {
            log.e("A launch decision listener threw", e)
        }
    }
    decisionListeners.clear()
}

private fun readForce(dataDir: String): PhoenixForce {
    val file = File(dataDir, "files/valenced/phoenix_mode").apply { ensureFile() }
    if (!file.exists()) return PhoenixForce.FOLLOW
    return when (file.readText().trim().lowercase()) {
        "phoenix" -> PhoenixForce.PHOENIX
        "rn" -> PhoenixForce.RN
        else -> PhoenixForce.FOLLOW
    }
}

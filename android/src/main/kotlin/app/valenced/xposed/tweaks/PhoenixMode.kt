package app.valenced.xposed.tweaks

import app.valenced.xposed.Tweak
import app.valenced.xposed.ensureFile
import app.valenced.xposed.hook
import app.valenced.xposed.loadClassOrNull
import app.valenced.xposed.methodHook
import app.valenced.xposed.api.registerNativeMethod
import app.valenced.xposed.tweak
import de.robv.android.xposed.XposedBridge
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

enum class PhoenixForce { FOLLOW, PHOENIX, RN }

var phoenixLaunched: Boolean? = null
    private set

var phoenixForce = PhoenixForce.FOLLOW
    private set

private val decisionListeners = CopyOnWriteArrayList<(Boolean) -> Unit>()

val xposedFramework by lazy {
    runCatching {
        val config = XposedBridge::class.java.classLoader!!.loadClass("org.lsposed.lspatch.share.LSPConfig")
        "LSPatch ${config.getField("VERSION_NAME").get(config.getField("instance").get(null))}"
    }.recoverCatching {
        (XposedBridge::class.java.getField("TAG").get(null) as String).removeSuffix("-Bridge")
    }.getOrDefault("Xposed") + " (API ${XposedBridge.getXposedVersion()})"
}

fun onLaunchDecision(block: (Boolean) -> Unit) {
    val decided = phoenixLaunched
    if (decided != null) block(decided)
    else decisionListeners += block
}

// PhoenixLaunch's decision method (R8 renames it per build) returns true to launch Phoenix
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

    val decide = dexFinder.findMethod {
        matcher {
            declaredClass(cls.name)
            returnType("boolean")
            paramTypes("android.content.ContextWrapper")
            usingStrings("Phoenix didn't stay up for 3 launches")
        }
    }
    if (decide == null) {
        log.e("PhoenixLaunch decision method not found, launch decision left to Discord")
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

internal fun readForce(dataDir: String): PhoenixForce {
    val file = File(dataDir, "files/valenced/phoenix_mode").apply { ensureFile() }
    if (!file.exists()) return PhoenixForce.FOLLOW
    return when (file.readText().trim().lowercase()) {
        "phoenix" -> PhoenixForce.PHOENIX
        "rn" -> PhoenixForce.RN
        else -> PhoenixForce.FOLLOW
    }
}

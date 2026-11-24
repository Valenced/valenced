package app.valenced.xposed.tweaks.plugins.internal

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.MotionEvent
import android.widget.Toast
import app.valenced.plugins.API_VERSION
import app.valenced.plugins.PluginManifest
import app.valenced.plugins.PluginScope
import app.valenced.plugins.PluginStatesStore
import app.valenced.reloadApp
import app.valenced.xposed.*
import app.valenced.xposed.api.registerNativeMethod
import app.valenced.xposed.tweaks.DevLoader
import app.valenced.xposed.tweaks.base.withAppActivity
import app.valenced.xposed.tweaks.crashRecoveryTriggered
import app.valenced.xposed.tweaks.phoenixLaunched
import app.valenced.xposed.tweaks.plugins.pluginPaths
import app.valenced.xposed.tweaks.resetCrashCount

private val manifest = PluginManifest(
    id = "valenced.recovery",
    name = "Recovery",
    description = "Handles errors and provides troubleshooting options for Valenced.",
    author = "Valenced",
    icon = "ShieldIcon",
    version = API_VERSION,
)

internal val recoveryPlugin =
    internalPlugin(manifest, setOf(InternalPluginFlags.INTERNAL, InternalPluginFlags.ESSENTIAL)) {
        start {
            // User stuck in Recovery mode. It is only ever intended to be one-shot.
            if (PluginStatesStore.activeSlotId == PluginStatesStore.DEFAULTS_SLOT) {
                PluginStatesStore.setActiveSlot(pluginPaths(appInfo.dataDir), PluginStatesStore.PRIMARY_SLOT, false)
            }

            addBridgeMethods()
            recoveryHook()
        }
    }

/**
 * For the actual shake-gesture hook, you should be looking at [app.valenced.xposed.tweaks.discordDevSupport].
 */
fun showRecoveryAlert(context: Context) {
    val options = listOf<Pair<String, () -> Unit>>(
        "Reload" to ::reloadApp,
        "Enter Recovery Mode" to {
            PluginStatesStore.setActiveSlot(
                pluginPaths(context.dataDir.absolutePath),
                PluginStatesStore.DEFAULTS_SLOT,
                oneShot = true,
            )
            reloadApp()
        },
    ) + DevLoader.recoveryOptions

    AlertDialog.Builder(context)
        .setTitle("Valenced Recovery Options")
        .setItems(options.map { it.first }.toTypedArray()) { _, which -> options[which].second() }
        .show()
}

fun PluginScope.addBridgeMethods() {
    withAppActivity { act ->
        registerNativeMethod("valenced.showRecoveryAlert") {
            showRecoveryAlert(act)
            null
        }

        if (phoenixLaunched != true) registerNativeMethod("valenced.alertError") {
            val (error, version) = it
            val errorString = "$error"

            val clipboard = act.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = ClipData.newPlainText("Stack Trace", errorString)

            AlertDialog.Builder(act)
                .setTitle("Valenced Error")
                .setMessage(
                    """
                        Valenced: $version
                        Discord: ${act.versionName()} (${act.versionCode()})
                        Device: ${Build.MANUFACTURER} ${Build.MODEL}
                        
                        
                    """.trimIndent() + errorString
                )
                .setPositiveButton(android.R.string.ok) { dialog, _ -> dialog.dismiss() }
                .setNeutralButton(android.R.string.copy) { dialog, _ ->
                    @Suppress("UsePropertyAccessSyntax")
                    clipboard.setPrimaryClip(clip)
                    Toast.makeText(act, "Copied stack trace", Toast.LENGTH_SHORT).show()
                    dialog.dismiss()
                }
                .setNegativeButton("Recovery") { dialog, _ ->
                    showRecoveryAlert(act)
                    dialog.dismiss()
                }
                .show()

            null
        }
    }
}

fun recoveryHook() {
    var holdRunnable: Runnable? = null
    val handler = Handler(Looper.getMainLooper())

    withAppActivity {
        if (crashRecoveryTriggered) {
            AlertDialog.Builder(it)
                .setTitle("Booted in Recovery Mode")
                .setMessage("Valenced detected consecutive crashes and has booted into Recovery Mode.")
                .setPositiveButton(android.R.string.ok) { d, _ -> d.dismiss() }
                .setNeutralButton("Exit Recovery Mode") { _, _ -> reloadApp() }
                .show()
        }

        val hook = Activity::class.java.method("dispatchTouchEvent", MotionEvent::class.java).hook {
            before {
                val event = param.args[0] as MotionEvent
                val activity = param.thisObject as Activity

                if (event.pointerCount == 2) {
                    when (event.actionMasked) {
                        // 3s hold timer when 2nd finger touches screen
                        MotionEvent.ACTION_POINTER_DOWN -> {
                            handler.postDelayed({
                                Toast.makeText(
                                    activity,
                                    "Keep holding to trigger Recovery Options...",
                                    Toast.LENGTH_SHORT
                                )
                                    .show()
                            }, 1500)

                            holdRunnable = { showRecoveryAlert(activity) }
                            handler.postDelayed(holdRunnable, 3000)
                        }

                        // Lifted finger early
                        MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_CANCEL -> {
                            holdRunnable?.let { handler.removeCallbacks(it) }
                        }
                    }
                }
            }
        }

        // Stop listening after 3s
        handler.postDelayed({
            hook.unhook()

            // Give users up to 2 extra seconds (5 - 3) to press the dialog options
            handler.postDelayed({
                resetCrashCount()
            }, 5000)
        }, 3000)

        // Intentional exit, so we clear the crash count
        Activity::class.java.method("onDestroy").hook {
            before {
                val activity = param.thisObject as Activity
                if (activity.isFinishing) resetCrashCount()
            }
        }
    }
}

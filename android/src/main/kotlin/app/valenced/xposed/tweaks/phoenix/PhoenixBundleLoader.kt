package app.valenced.xposed.tweaks.phoenix

import android.content.res.XModuleResources
import app.valenced.xposed.ValencedConstants
import app.valenced.xposed.phoenix.PhoenixRuntime
import app.valenced.xposed.tweak
import app.valenced.xposed.tweaks.onLaunchDecision
import java.io.File

/** Overrides the shipped bundle when present, so a bundle can be pushed to the emulator. */
private const val DEV_BUNDLE = "phoenix.bundle.js"

/**
 * Starts the QuickJS runtime and evaluates the Phoenix bundle when Discord launches Phoenix.
 *
 * This runs inside the launch decision hook, before Phoenix's activity starts, so the bundle is
 * in place before any frame or gateway event arrives.
 */
val phoenixBundleLoader by tweak {
    onLaunchDecision { phoenix ->
        if (!phoenix) return@onLaunchDecision
        if (!PhoenixRuntime.start(modulePath, appInfo)) return@onLaunchDecision

        val override = File(appInfo.dataDir, "${ValencedConstants.FILES_DIR}/$DEV_BUNDLE")
        val source = if (override.isFile && override.length() > 0) {
            log.i("Loading the development Phoenix bundle: ${override.path}")
            override.readBytes()
        } else {
            XModuleResources.createInstance(modulePath, null).assets
                .open(ValencedConstants.PHOENIX_BUNDLE_ASSET)
                .use { it.readBytes() }
        }

        val error = PhoenixRuntime.evaluate(source, ValencedConstants.PHOENIX_BUNDLE_ASSET)
        if (error != null) log.e("The Phoenix bundle failed to evaluate: $error")
        else log.i("Evaluated the Phoenix bundle, ${source.size} bytes")
    }
}

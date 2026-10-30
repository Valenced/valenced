// SPDX-FileCopyrightText: 2026 Cossale <hello@auna.li>
// SPDX-License-Identifier: AGPL-3.0-or-later

package app.valenced.patches.discord

import app.reseam.patch.patch
import java.io.File

/** Discord's launcher icons, both adaptive icons over a channel colour. */
private val LAUNCHER_ICONS = listOf(
    "ic_logo_square", "ic_logo_round",
    "ic_logo_square_beta", "ic_logo_round_beta",
    "ic_logo_square_canary", "ic_logo_round_canary"
)

private const val BACKGROUND = "valenced_icon_background"
private const val FOREGROUND = "valenced_icon_foreground"
private const val CUSTOM = "valenced_icon_custom"

val valencedIcon = patch("Valenced icon") {
    description("Puts Discord's launcher icon on Valenced's cyan, or replaces it with an image.")
    compatibleWith(DISCORD)

    val iconOption = pathOption(
        "icon",
        title = "Custom icon",
        description = "The image to use as the launcher icon.",
    )

    execute {
        val custom = options.getOrNull(iconOption)?.let { File(it.path).readBytes() }
        if (custom != null) {
            resources.addColor(BACKGROUND, "#FF000000")
            resources.addFile("drawable", CUSTOM, "res/$CUSTOM.png", custom)
        } else {
            resources.addColor(BACKGROUND, "#FF37EBFF")
            resources.addColor(FOREGROUND, "#FF000000")
        }
        for (icon in LAUNCHER_ICONS) {
            // Some icons may not exist due to resource shrinking
            if (!resources.exists("mipmap", icon)) continue

            // The adaptive icon is the anydpi-v26 configuration; the density ones are plain PNGs.
            val adaptive = resources.paths("mipmap", icon).filter { it.endsWith(".xml") }
            check(adaptive.isNotEmpty()) { "mipmap/$icon has no adaptive icon" }
            adaptive.forEach { path ->
                files.editXml(path) {
                    val background = findByTag("background").singleOrNull() ?: error("$path has no background layer")
                    background["android:drawable"] = "@color/$BACKGROUND"

                    val foreground = findByTag("foreground").singleOrNull() ?: error("$path has no foreground layer")
                    val drawable = foreground["android:drawable"] ?: error("$path has no foreground drawable")
                    if (custom != null) {
                        foreground["android:drawable"] = "@drawable/$CUSTOM"
                    } else {
                        // The foreground is a PNG mipmap shared with the rest of the app, so tint an inline
                        // copy rather than the mipmap itself. A layer without android:drawable inflates its child.
                        foreground.removeAttribute("android:drawable")
                        foreground.appendChild(createElement("bitmap").apply {
                            this["android:src"] = drawable
                            this["android:tint"] = "@color/$FOREGROUND"
                        })
                    }
                }
            }
        }
    }
}

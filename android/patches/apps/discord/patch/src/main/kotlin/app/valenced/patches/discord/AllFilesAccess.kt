// SPDX-FileCopyrightText: 2026 Anderinfera
// SPDX-License-Identifier: AGPL-3.0-or-later

package app.valenced.patches.discord

import app.reseam.patch.patch

private const val MANAGE_EXTERNAL_STORAGE = "android.permission.MANAGE_EXTERNAL_STORAGE"

val allFilesAccess = patch("All files access") {
    description("Declares All files access, so users can grant it to Discord in Android's settings.")
    compatibleWith(DISCORD)

    execute {
        manifest.edit {
            if (findByTag("uses-permission").any { it["android:name"] == MANAGE_EXTERNAL_STORAGE }) return@edit
            root.appendChild(createElement("uses-permission").apply {
                this["android:name"] = MANAGE_EXTERNAL_STORAGE
            })
        }
    }
}

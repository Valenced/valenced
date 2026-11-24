package app.valenced.xposed.tweaks.phoenix

import android.app.Activity
import android.app.AlertDialog
import android.app.Application
import android.app.Dialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.DialogInterface
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.RippleDrawable
import android.graphics.drawable.StateListDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.Base64
import android.text.SpannableString
import android.text.TextUtils
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import android.text.style.ImageSpan
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import app.valenced.xposed.api.HostScope
import app.valenced.xposed.tweaks.plugins.pluginRegistry
import app.valenced.xposed.tweaks.plugins.restartPlugin
import app.valenced.xposed.tweaks.plugins.stopPlugin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import androidx.core.graphics.ColorUtils
import androidx.core.text.bold
import androidx.core.text.buildSpannedString
import androidx.core.text.color
import androidx.core.text.inSpans
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.widget.TextViewCompat
import androidx.core.widget.doAfterTextChanged
import app.valenced.reloadApp
import app.valenced.xposed.ValencedConstants
import app.valenced.xposed.api.registerNativeMethod
import app.valenced.xposed.tweak
import app.valenced.xposed.tweaks.bridge.ValencedBridgeRegistry
import app.valenced.xposed.tweaks.phoenixLaunched
import app.valenced.xposed.tweaks.readForce
import app.valenced.xposed.tweaks.xposedFramework
import java.io.File
import java.lang.ref.WeakReference
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine

val phoenixSettings by tweak {
    var foreground = WeakReference<Activity>(null)
    withAppContext { ctx ->
        (ctx as? Application ?: ctx.applicationContext as Application).registerActivityLifecycleCallbacks(
            object : Application.ActivityLifecycleCallbacks {
                override fun onActivityResumed(activity: Activity) {
                    foreground = WeakReference(activity)
                }

                override fun onActivityDestroyed(activity: Activity) {
                    if (foreground.get() === activity) foreground = WeakReference(null)
                }

                override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
                override fun onActivityStarted(activity: Activity) {}
                override fun onActivityPaused(activity: Activity) {}
                override fun onActivityStopped(activity: Activity) {}
                override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            },
        )
    }

    registerNativeMethod("valenced.phoenix.openSettings") { args ->
        Handler(Looper.getMainLooper()).post {
            val activity = foreground.get()
            if (activity == null || activity.isFinishing) log.w("No foreground activity to open settings on")
            else PhoenixSettingsScreen(this, activity, args.getOrNull(0) as? Map<*, *>, args.getOrNull(1) as? Map<*, *>)
                .show()
        }
        null
    }
}

private class PhoenixSettingsScreen(
    private val host: HostScope,
    private val activity: Activity,
    private val theme: Map<*, *>?,
    private val info: Map<*, *>?,
) {
    private val backdrop = color("background", 0xFF242429)
    private val surface = color("card", 0x1497979F)
    private val pressed = color("pressed", 0x12FFFFFF)
    private val divider = color("divider", 0x1F97979F)
    private val primary = color("text", 0xFFFBFBFB)
    private val secondary = color("muted", 0xFFABACB2)
    private val danger = color("danger", 0xFFF87E7A)
    private val field = color("field", 0x1F000000)
    private val outline = color("outline", 0x3397979F)
    private val brand = resource("brand", 0xFF5865F2)
    private val white = resource("white", 0xFFFFFFFF)
    private val critical = resource("red_new_50", 0xFFD22D39)
    private val scrim = ColorUtils.setAlphaComponent(resource("black", 0xFF000000), 0x99)
    private val dark = ColorUtils.calculateLuminance(backdrop) < 0.5
    private val link = resource(if (dark) "brand_400" else "brand_560", 0xFF5865F2)
    private val medium = font("ggsans-Medium")
    private val semibold = font("ggsans-Semibold")

    private val stack = ArrayDeque<() -> Unit>()
    private val dialog = object : Dialog(
        activity,
        if (dark) android.R.style.Theme_DeviceDefault_NoActionBar
        else android.R.style.Theme_DeviceDefault_Light_NoActionBar,
    ) {
        @Deprecated("Deprecated in Java")
        override fun onBackPressed() = back()
    }
    private val ctx: Context = dialog.context
    private val scope = MainScope()
    private var pageJob: Job? = null
    private var dirty = false
    private var group: LinearLayout? = null
    private val overlays = mutableListOf<Dialog>()
    private var query = ""
    private var onQuery: (() -> Unit)? = null
    private val installedHere = mutableSetOf<String>()
    private val modes = listOf("follow" to "Follow Discord", "phoenix" to "Phoenix", "rn" to "React Native")
    private val modeFile = File(activity.filesDir, "valenced/phoenix_mode")
    private val filters = mutableSetOf("Configurable")
    private var matchAll = true
    private var sortBy = "Name"
    private var reverse = false

    private val title = text("", primary, 18f, semibold).apply {
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
    }
    private val actions = LinearLayout(ctx).apply { gravity = Gravity.CENTER_VERTICAL }
    private val search = input("Search").apply {
        doAfterTextChanged {
            query = it.toString().trim().lowercase()
            onQuery?.invoke()
        }
    }
    private val filterButton = iconButton("FiltersHorizontalIcon", "Filter & Sort", primary) { showFilters() }
    private val toolbar = LinearLayout(ctx).apply {
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(16), dp(16), dp(16), 0)
        addView(search, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        addView(filterButton, LinearLayout.LayoutParams(dp(40), dp(40)).apply { marginStart = dp(8) })
    }
    private val body = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
    private val scroll = ScrollView(ctx).apply {
        clipToPadding = false
        addView(body)
    }
    private val fab = ImageView(ctx).apply {
        scaleType = ImageView.ScaleType.CENTER
        setImageDrawable(icon("PlusLargeIcon", white))
        background = RippleDrawable(ColorStateList.valueOf(pressed), shape(brand, 16), null)
        elevation = dp(4).toFloat()
    }

    fun show() {
        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(backdrop)
            addView(LinearLayout(ctx).apply {
                gravity = Gravity.CENTER_VERTICAL
                minimumHeight = dp(60)
                setPadding(dp(8), 0, dp(16), 0)
                addView(iconButton("ArrowLargeLeftIcon", "Back", secondary) { back() })
                addView(title, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginStart = dp(8) })
                addView(actions)
            })
            addView(toolbar)
            addView(FrameLayout(ctx).apply {
                addView(scroll)
                addView(fab, FrameLayout.LayoutParams(dp(56), dp(56), Gravity.BOTTOM or Gravity.END).apply {
                    setMargins(0, 0, dp(16), dp(16))
                })
            }, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        dialog.setContentView(root)
        dialog.window?.let { window ->
            window.setLayout(MATCH_PARENT, MATCH_PARENT)
            window.setBackgroundDrawable(ColorDrawable(backdrop))
            WindowCompat.setDecorFitsSystemWindows(window, false)
            @Suppress("DEPRECATION")
            window.statusBarColor = Color.TRANSPARENT
            @Suppress("DEPRECATION")
            window.navigationBarColor = Color.TRANSPARENT
            WindowCompat.getInsetsController(window, window.decorView).run {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
        dialog.setOnDismissListener { scope.cancel() }
        dialog.show()
        open(if (info?.get("page") == "valenced") ::showValenced else ::showPlugins)
    }

    private fun showPlugins() = page(
        "Plugins",
        iconButton("SettingsIcon", "Repositories", primary) { open(::showRepos) },
    ) {
        val slots = call("valenced.plugins.states.getSlots") as Map<*, *>
        val states = (call("valenced.plugins.states.read") as Map<*, *>)[slots["active"]] as? Map<*, *>
        // Bundle entries without metadata, the RN bundle names them at runtime
        val all = (call("valenced.plugins.list") as List<*>).map { it as Map<*, *> }
            .filter { (it["manifest"] as Map<*, *>).let { manifest -> manifest["name"] != manifest["id"] } }
        val configurable = all.associate { (it["manifest"] as Map<*, *>)["id"] to settingsFor(it).isNotEmpty() }
        val enabled = all.associate { plugin ->
            val id = (plugin["manifest"] as Map<*, *>)["id"]
            val entry = states?.get(id) as? Map<*, *>
            id to (entry?.get("enabled") == true || (plugin["enabledByDefault"] == true && entry == null))
        }
        val plugins = all.filter { plugin ->
            val id = (plugin["manifest"] as Map<*, *>)["id"]
            val checks = filters.map {
                when (it) {
                    "Enabled" -> enabled[id] == true
                    "Disabled" -> enabled[id] != true
                    "Has Errors" -> plugin["failed"] == true || (plugin["errors"] as? List<*>).orEmpty().isNotEmpty()
                    "Pending Reload" -> (states?.get(id) as? Map<*, *>)?.get("pendingReload") == true
                    "Configurable" -> plugin["essential"] != true || configurable[id] == true
                    else -> plugin["internal"] == true
                }
            }
            checks.isEmpty() || if (matchAll) checks.all { it } else checks.any { it }
        }.sortedWith(
            compareBy<Map<*, *>> { sortBy != "Name" && enabled[(it["manifest"] as Map<*, *>)["id"]] != true }
                .thenBy { (it["manifest"] as Map<*, *>)["name"].toString().lowercase() },
        ).let { if (reverse) it.reversed() else it }

        val custom = filters != setOf("Configurable") || !matchAll || sortBy != "Name" || reverse
        filterButton.visibility = View.VISIBLE
        filterButton.setImageDrawable(icon("FiltersHorizontalIcon", if (custom) white else primary))
        filterButton.background = RippleDrawable(ColorStateList.valueOf(pressed), if (custom) shape(brand, 8) else null, null)
        fab.visibility = View.VISIBLE
        fab.contentDescription = "Browse plugins"
        fab.setOnClickListener { open { showBrowse(null) } }

        filtered {
            if (dirty) body.addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(16), dp(16), dp(16), dp(16))
                background = shape(surface, 16)
                addView(LinearLayout(ctx).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    addView(ImageView(ctx).apply { setImageDrawable(icon("RetryIcon", primary)) },
                        LinearLayout.LayoutParams(dp(20), dp(20)).apply { marginEnd = dp(8) })
                    addView(text("Reload to apply changes", primary, 16f, semibold))
                })
                addView(button("Reload now") { reloadApp() }, LinearLayout.LayoutParams(MATCH_PARENT, dp(32)).apply {
                    topMargin = dp(12)
                })
            }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(12) })

            for (plugin in plugins) {
                val manifest = plugin["manifest"] as Map<*, *>
                val id = manifest["id"] as String
                val name = manifest["name"] as String
                val description = manifest["description"] as? String
                val author = (manifest["author"] as? String)?.substringBefore(" <")?.substringBefore(" (")
                if (listOfNotNull(name, description, author).none { query in it.lowercase() }) continue

                val failed = plugin["failed"] == true

                card(
                    name,
                    manifest["icon"] as? String,
                    if (failed) SpannableString("Failed to load").apply {
                        setSpan(ForegroundColorSpan(danger), 0, length, 0)
                    } else description,
                    LinearLayout(ctx).apply {
                        gravity = Gravity.CENTER_VERTICAL
                        if (configurable[id] == true) addView(
                            iconButton("SettingsIcon", "Settings", primary) { open { showPluginSettings(plugin) } }.apply {
                                scaleType = ImageView.ScaleType.FIT_CENTER
                                setPadding(dp(8), dp(8), dp(8), dp(8))
                                background = RippleDrawable(ColorStateList.valueOf(pressed), shape(surface, 8), null)
                                if (enabled[id] != true) alpha = 0.5f
                            },
                            LinearLayout.LayoutParams(dp(32), dp(32)).apply { marginEnd = dp(8) },
                        )
                        if (!failed) addView(toggle(enabled[id] == true) { on ->
                            action {
                                try {
                                    call("valenced.plugins.setEnabled", id, on, on)
                                    dirty = true
                                } finally {
                                    refresh()
                                }
                            }
                        }.apply {
                            if (plugin["essential"] == true) {
                                isEnabled = false
                                alpha = 0.5f
                            }
                        })
                    },
                ) { showPluginSheet(id) }
            }
        }
    }

    private fun showFilters(reuse: Pair<Dialog, LinearLayout>? = null) {
        val (sheet, content) = reuse ?: overlay(true)
        content.removeAllViews()
        val update = { change: () -> Unit ->
            change()
            refresh()
            showFilters(sheet to content)
        }

        content.addView(
            text("Filter & Sort", primary, 18f, semibold).apply { gravity = Gravity.CENTER },
            LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(8) },
        )
        section("Filter by", icons = true, into = content) {
            for ((label, icon) in listOf(
                "Enabled" to "CircleCheckIcon",
                "Disabled" to "CircleXIcon",
                "Has Errors" to "CircleErrorIcon",
                "Pending Reload" to "RetryIcon",
                "Configurable" to "SettingsIcon",
                "Internal" to info?.get("icon") as? String,
            )) {
                val checked = label in filters
                row(label, emptyList(), ImageView(ctx).apply {
                    scaleType = ImageView.ScaleType.CENTER
                    if (checked) setImageDrawable(icon("CheckmarkLargeIcon", white))
                    background = GradientDrawable().apply {
                        cornerRadius = dp(6).toFloat()
                        if (checked) setColor(brand)
                        else setStroke(dp(2), ColorUtils.setAlphaComponent(secondary, 0x8C))
                    }
                    layoutParams = ViewGroup.LayoutParams(dp(24), dp(24))
                }, icon = icon) { update { if (checked) filters -= label else filters += label } }
            }
        }
        section(null, into = content) {
            row("Match all", emptyList(), toggle(matchAll) { on -> update { matchAll = on } })
        }
        section("Sort by", icons = true, into = content) {
            for ((label, icon) in listOf("Name" to "IdIcon", "Enabled first" to "CircleCheckIcon"))
                row(label, emptyList(), radio(sortBy == label), icon = icon) { update { sortBy = label } }
        }
        section(null, into = content) {
            row("Reverse results", emptyList(), toggle(reverse) { on -> update { reverse = on } })
        }
        if (reuse == null) sheet.show()
    }

    private fun showPluginSheet(id: String, reuse: Pair<Dialog, LinearLayout>? = null): Unit = action {
        val plugins = (call("valenced.plugins.list") as List<*>).map { it as Map<*, *> }
        val plugin = plugins.first { (it["manifest"] as Map<*, *>)["id"] == id }
        val manifest = plugin["manifest"] as Map<*, *>
        val name = manifest["name"] as String
        val version = versionOf(manifest)
        val fields = settingsFor(plugin)
        val slots = call("valenced.plugins.states.getSlots") as Map<*, *>
        val states = (call("valenced.plugins.states.read") as Map<*, *>)[slots["active"]] as? Map<*, *>
        val isEnabled = { other: Map<*, *> ->
            val entry = states?.get((other["manifest"] as Map<*, *>)["id"]) as? Map<*, *>
            entry?.get("enabled") == true || (other["enabledByDefault"] == true && entry == null)
        }
        val entry = states?.get(id) as? Map<*, *>
        val enabled = isEnabled(plugin)
        val internal = plugin["internal"] == true
        val source = plugin["source"] as? Map<*, *>
        val repo = source?.get("repo") as? String
        val repoName = (call("valenced.plugins.repos.list") as List<*>)
            .firstOrNull { (it as Map<*, *>)["url"] == repo }?.let { (it as Map<*, *>)["name"] as? String }
        val builtIn = internal && source == null
        val held = source?.get("held") == true
        val target = if (held) mapOf("repo" to repo, "version" to version)
        else mapOf("repo" to repo, "channel" to (source?.get("channel") ?: "latest"), "compatible" to true)
        val dependencies = manifest["dependencies"] as? Map<*, *> ?: emptyMap<Any?, Any?>()
        val dependents = plugins.filter { (((it["manifest"] as Map<*, *>)["dependencies"] as? Map<*, *>)?.get(id)) != null }
        val errors = (plugin["errors"] as? List<*>).orEmpty().map { it as Map<*, *> }

        val (sheet, content) = reuse ?: overlay(true)
        content.removeAllViews()
        val reopen = {
            refresh()
            showPluginSheet(id, sheet to content)
        }
        val leave = { page: () -> Unit ->
            sheet.dismiss()
            open(page)
        }

        info(
            content,
            name,
            manifest["icon"] as? String,
            if (plugin["essential"] == true || plugin["failed"] == true) null else toggle(enabled) { on ->
                action {
                    try {
                        call("valenced.plugins.setEnabled", id, on, on)
                        dirty = true
                    } finally {
                        reopen()
                    }
                }
            },
            manifest["author"] as? String,
            manifest["contributors"] as? List<*>,
            version,
            manifest["description"] as? String,
        )

        content.addView(LinearLayout(ctx).apply {
            setPadding(dp(8), dp(40), dp(8), dp(16))
            for ((label, icon, onClick) in listOfNotNull(
                if (fields.isEmpty()) null else Triple("Settings", "SettingsIcon") { leave { showPluginSettings(plugin) } },
                if (!enabled || plugin["essential"] == true) null else (id in pluginRegistry.loaded).let { running ->
                    Triple(if (running) "Stop" else "Start", if (running) "HandRequestSpeakIcon" else "PlayIcon") {
                        action {
                            withContext(Dispatchers.Default) { with(host) { if (running) stopPlugin(id) else restartPlugin(id) } }
                            reopen()
                        }
                    }
                },
                Triple("Clear Data", "FileWarningIcon") {
                    action {
                        if (!confirm(
                                "Clear plugin data?",
                                "All data, including files and settings for $name will be deleted",
                                "Clear",
                                true,
                            )
                        ) return@action
                        pluginStorageFile(id).parentFile?.deleteRecursively()
                        if (plugin["failed"] != true) call("valenced.plugins.settings.clear", id)
                        sheet.dismiss()
                        refresh()
                    }
                },
                if (internal) null else Triple(
                    if (plugin["hasStub"] == true) "Uninstall updates" else "Uninstall",
                    "TrashIcon",
                ) {
                    action {
                        val disabled = mutableListOf<Map<*, *>>()
                        val queue = ArrayDeque(if (enabled) listOf(id) else emptyList())
                        while (queue.isNotEmpty()) {
                            val next = queue.removeFirst()
                            for (other in plugins) {
                                val otherManifest = other["manifest"] as Map<*, *>
                                val dependency = (otherManifest["dependencies"] as? Map<*, *>)?.get(next) as? Map<*, *>
                                if (dependency == null || dependency["optional"] == true || other in disabled || !isEnabled(other))
                                    continue
                                disabled += other
                                queue += otherManifest["id"] as String
                            }
                        }

                        val updates = plugin["hasStub"] == true
                        if (!confirm(
                                if (updates) "Uninstall updates for $name?" else "Uninstall $name?",
                                if (updates) "The built-in version of $name will be restored. All of its data will be removed. This cannot be undone."
                                else "$name and all of its data will be removed. This cannot be undone.",
                                if (updates) "Uninstall updates" else "Uninstall",
                                true,
                            ) { modal ->
                                if (entry?.get("pendingReload") == true) modal.addView(
                                    text("This plugin is pending a reload. Uninstalling now may leave unintended side effects.", danger, 16f, semibold),
                                    LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(16) },
                                )
                                if (disabled.isNotEmpty()) modal.addView(
                                    text("These plugins need $name, so they will be disabled:", primary, 16f, semibold),
                                    LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
                                        topMargin = dp(16)
                                        bottomMargin = dp(12)
                                    },
                                )
                                for (other in disabled) (other["manifest"] as Map<*, *>).let {
                                    card(it["name"] as String, it["icon"] as? String, it["description"] as? String, null, modal)
                                }
                            }
                        ) return@action
                        call("valenced.plugins.uninstall", id)
                        dirty = true
                        sheet.dismiss()
                        refresh()
                    }
                },
            )) addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER_HORIZONTAL
                val destructive = icon == "TrashIcon"
                addView(ImageView(ctx).apply {
                    scaleType = ImageView.ScaleType.CENTER
                    setImageDrawable(icon(icon, if (destructive) white else primary))
                    contentDescription = label
                    background = RippleDrawable(
                        ColorStateList.valueOf(pressed),
                        shape(if (destructive) critical else surface, 8),
                        null,
                    )
                    setOnClickListener { onClick() }
                }, LinearLayout.LayoutParams(dp(48), dp(48)))
                addView(text(label, secondary, 14f).apply { gravity = Gravity.CENTER }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply {
                    topMargin = dp(8)
                })
            }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        })

        if (errors.isNotEmpty()) section(null, icons = true, into = content) {
            row("Errors", listOf("${errors.size} errors. Tap to copy."), icon = "CircleErrorIcon", tint = danger) {
                copy("Errors", errors.joinToString("\n\n") { listOfNotNull(it["message"], it["stack"]).joinToString("\n") })
            }
        }
        section("Updates", icons = true, into = content) {
            if (!internal) row(
                "Allow updates",
                listOfNotNull(if (held) SpannableString(
                    "Other plugins won't be able to update if they need a newer version of $name",
                ).apply { setSpan(ForegroundColorSpan(danger), 0, length, 0) } else null),
                toggle(!held) { on ->
                    action {
                        try {
                            call("valenced.plugins.setHeld", id, !on)
                        } finally {
                            reopen()
                        }
                    }
                },
                icon = "RefreshIcon",
            )
            row(
                "Repository",
                listOf(if (repo != null) repoName?.let { "$it ($repo)" } ?: repo else if (builtIn) "Built-in" else "Sideloaded"),
                *if (builtIn) emptyArray() else arrayOf(chevron()),
                icon = "GlobeEarthIcon",
                onClick = if (builtIn) null else {
                    {
                        leave {
                            showRepoPicker(id, name, repo) { url, listing ->
                                if (install(id, retarget(target, url, listing))) back()
                            }
                        }
                    }
                },
            )
            row(
                if (repo != null && !held) "Channel" else "Version",
                listOf(if (repo != null && !held) "${target["channel"]} • v$version" else "v$version"),
                *if (repo == null) emptyArray() else arrayOf(chevron()),
                icon = "LocationIcon",
                onClick = if (repo == null) null else {
                    {
                        leave {
                            showRefPicker(id, repo, target) { picked ->
                                val note = (picked["version"] as? String)?.let {
                                    "Updates will be paused to stay on v$it. Pick a channel or turn on \"Allow updates\" to receive updates again."
                                }
                                if (install(id, picked, note)) back()
                            }
                        }
                    }
                },
            )
        }
        section("Advanced", icons = true, into = content) {
            row("ID", listOf(id), icon = "IdIcon") { copy("ID", id) }
            row(
                "Flags",
                listOf(listOfNotNull(
                    "Enabled".takeIf { enabled },
                    "RequiredByUser".takeIf { entry?.get("requiredByUser") == true },
                    "PendingReload".takeIf { entry?.get("pendingReload") == true },
                    "StartedLate".takeIf { entry?.get("startedLate") == true },
                ).joinToString(", ").ifEmpty { "None" }),
                icon = "FlagIcon",
            )
            listOf("internal" to "Internal", "essential" to "Essential", "api" to "API")
                .filter { plugin[it.first] == true }
                .takeIf { it.isNotEmpty() }
                ?.let { row("Internal Flags", listOf(it.joinToString(", ") { flag -> flag.second }), icon = "FlagIcon") }
            if (dependencies.isNotEmpty()) row(
                "Dependencies",
                listOf("$name depends on ${dependencies.size} other plugins"),
                icon = "ListBulletsIcon",
            ) { leave { showRelations(id, false) } }
            if (dependents.isNotEmpty()) row(
                "Dependents",
                listOf("${dependents.size} other plugins depend on $name"),
                icon = "ListBulletsIcon",
            ) { leave { showRelations(id, true) } }
        }
        if (reuse == null) sheet.show()
    }

    private fun showRelations(id: String, dependents: Boolean) = page(if (dependents) "Dependents" else "Dependencies") {
        val plugins = (call("valenced.plugins.list") as List<*>).map { it as Map<*, *> }
        val manifest = plugins.first { (it["manifest"] as Map<*, *>)["id"] == id }["manifest"] as Map<*, *>
        val name = manifest["name"] as String
        val dependencies = manifest["dependencies"] as? Map<*, *> ?: emptyMap<Any?, Any?>()
        val requirement = { dependency: Map<*, *> ->
            "(${dependency["version"] ?: "*"} ${if (dependency["optional"] == true) "optional" else "required"})"
        }

        render {
            section(if (dependents) "Dependents of $name" else "Dependencies of $name", icons = true) {
                for (plugin in plugins) {
                    val other = plugin["manifest"] as Map<*, *>
                    val dependency = (if (dependents) (other["dependencies"] as? Map<*, *>)?.get(id)
                    else dependencies[other["id"]]) as? Map<*, *> ?: continue
                    val line = "${other["id"]}@${versionOf(other)}" + if (dependents) "" else " ${requirement(dependency)}"
                    row(other["name"] as String, listOf(line), icon = other["icon"] as? String ?: "PuzzlePieceIcon") {
                        copy(other["name"] as String, line)
                    }
                }
            }
            val installed = plugins.map { (it["manifest"] as Map<*, *>)["id"] }
            val missing = if (dependents) emptyList() else dependencies.keys.filter { it !in installed }
            if (missing.isNotEmpty()) section("Unsatisfied dependencies of $name", icons = true) {
                for (missingId in missing) {
                    val line = "$missingId (not installed) ${requirement(dependencies[missingId] as Map<*, *>)}"
                    row(missingId.toString(), listOf(line), icon = "CircleQuestionIcon", tint = danger) {
                        copy(missingId.toString(), missingId.toString())
                    }
                }
            }
        }
    }

    private fun showPluginSettings(plugin: Map<*, *>, parent: Map<*, *>? = null): Unit = page(
        parent?.get("label") as? String ?: "${(plugin["manifest"] as Map<*, *>)["name"]} Settings",
    ) {
        val manifest = plugin["manifest"] as Map<*, *>
        val id = manifest["id"] as String
        val declaredSettings = parent?.get("settings") as? List<*> ?: manifest["settings"] as? List<*>
        val declared = declaredSettings != null
        val fields = declaredSettings?.map { it as Map<*, *> } ?: settingsFor(plugin)
        val stored = if (declared) call("valenced.plugins.settings.read", id) as? Map<*, *> ?: emptyMap<Any?, Any?>()
        else emptyMap<Any?, Any?>()
        val values = (if (parent == null) stored else stored[parent["key"]] as? Map<*, *> ?: emptyMap<Any?, Any?>())
            .toMutableMap()
        val prefix = parent?.let { "${it["key"]}." }.orEmpty()

        render {
            val rows = mutableListOf<Pair<Map<*, *>, View>>()
            val update = {
                for ((setting, view) in rows) (setting["showIf"] as? Map<*, *>)?.let { condition ->
                    val current = values[condition["key"]]
                    val expected = condition["equals"]
                    view.visibility = if (current == expected ||
                        current is Number && expected is Number && current.toDouble() == expected.toDouble()
                    ) View.VISIBLE else View.GONE
                }
            }
            val groups = fields.groupBy { it["section"] as? String }
            for ((sectionName, settings) in groups) {
                section(sectionName) {
                    for (setting in settings) {
                        val key = setting["key"] as String
                        val path = prefix + key
                        val type = setting["type"] as String
                        val label = setting["label"] as String
                        val description = setting["description"] as? String
                        val value = values[key] ?: setting["value"] ?: setting["default"]
                        rows += setting to when (type) {
                            "switch" -> row(label, listOfNotNull(description), toggle(value == true) { next ->
                                action {
                                    writeSetting(id, path, next, declared)
                                    refresh()
                                }
                            })
                            "select" -> row(label, listOfNotNull(description, (setting["options"] as? List<*>)
                                ?.firstOrNull { (it as Map<*, *>)["value"] == value }
                                ?.let { (it as Map<*, *>)["label"] as? String }), icon = "ArrowSmallRightIcon") {
                                open { showSelectSetting(plugin, setting, path, declared, value) }
                            }
                            "color" -> row(label, listOfNotNull(description, value as? String), View(ctx).apply {
                                background = shape(
                                    runCatching { Color.parseColor(value as String) }.getOrDefault(Color.TRANSPARENT),
                                    8,
                                ).apply { setStroke(dp(1), outline) }
                                layoutParams = ViewGroup.LayoutParams(dp(28), dp(28))
                            }) { showColorPicker(id, setting, path, value as? String ?: "") }
                            "list" -> row(
                                label,
                                listOfNotNull(description, (value as? List<*>)?.takeIf { it.isNotEmpty() }?.joinToString(", ")),
                                chevron(),
                            ) { open { showListSetting(plugin, setting, path) } }
                            "object" -> row(label, listOfNotNull(description), chevron()) {
                                open { showPluginSettings(plugin, setting) }
                            }
                            else -> {
                                val error = text("", danger, 12f).apply { visibility = View.GONE }
                                var pending: Job? = null
                                val editor = input(label).apply {
                                    setText(value?.toString().orEmpty())
                                    if (type == "number") setInputType(
                                        InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or
                                                InputType.TYPE_NUMBER_FLAG_SIGNED,
                                    )
                                    doAfterTextChanged {
                                        val (next, problem) = parse(setting, type, it.toString())
                                        error.text = problem
                                        error.visibility = if (problem == null) View.GONE else View.VISIBLE
                                        background = shape(field, 8).apply { setStroke(dp(1), if (problem == null) outline else danger) }
                                        pending?.cancel()
                                        if (problem != null) return@doAfterTextChanged
                                        values[key] = next
                                        update()
                                        pending = scope.launch {
                                            delay(300)
                                            action { writeSetting(id, path, next, declared) }
                                        }
                                    }
                                }
                                row(label, listOfNotNull(description), LinearLayout(ctx).apply {
                                    orientation = LinearLayout.VERTICAL
                                    addView(editor, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
                                    addView(error, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(4) })
                                })
                            }
                        }
                    }
                }
            }
            update()
        }
    }

    private fun showSelectSetting(plugin: Map<*, *>, setting: Map<*, *>, path: String, declared: Boolean, selected: Any?) = page(
        setting["label"] as String,
    ) {
        val id = (plugin["manifest"] as Map<*, *>)["id"] as String
        render {
            section(setting["section"] as? String) {
                for (option in setting["options"] as List<*>) {
                    option as Map<*, *>
                    val value = option["value"]
                    row(option["label"] as String, emptyList(), radio(value == selected), onClick = {
                        action {
                            writeSetting(id, path, value, declared)
                            back()
                        }
                    })
                }
            }
        }
    }

    private fun showListSetting(plugin: Map<*, *>, setting: Map<*, *>, path: String) = page(setting["label"] as String) {
        val id = (plugin["manifest"] as Map<*, *>)["id"] as String
        val type = setting["item"] as? String ?: "text"
        val max = (setting["maxItems"] as? Number)?.toInt()
        val items = path.split(".").fold<String, Any?>(call("valenced.plugins.settings.read", id)) { node, key ->
            (node as? Map<*, *>)?.get(key)
        } as? List<*> ?: emptyList<Any?>()
        val edit = { at: Int? ->
            val (sheet, content) = overlay(true)
            val error = text("", danger, 12f).apply { visibility = View.GONE }
            val editor = input("")
            val save = button("Save") {
                val (next, problem) = parse(setting, type, editor.text.toString())
                if (problem == null) action {
                    writeSetting(id, path, items.toMutableList().apply { if (at == null) add(next) else set(at, next) }, true)
                    sheet.dismiss()
                    refresh()
                }
            }
            editor.apply {
                if (type == "number") setInputType(
                    InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or InputType.TYPE_NUMBER_FLAG_SIGNED,
                )
                doAfterTextChanged {
                    val problem = parse(setting, type, it.toString()).second
                    error.text = problem
                    error.visibility = if (problem == null) View.GONE else View.VISIBLE
                    background = shape(field, 8).apply { setStroke(dp(1), if (problem == null) outline else danger) }
                    save.isEnabled = problem == null
                    save.alpha = if (problem == null) 1f else 0.5f
                }
                setText(at?.let { "${items[it]}" }.orEmpty())
                requestFocus()
            }
            content.addView(
                text(setting["label"] as String, primary, 18f, semibold).apply { gravity = Gravity.CENTER },
                LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(16) },
            )
            content.addView(editor)
            content.addView(error, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(4) })
            content.addView(save, LinearLayout.LayoutParams(MATCH_PARENT, dp(40)).apply { topMargin = dp(16) })
            sheet.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)
            sheet.show()
        }

        render {
            section(null) {
                items.forEachIndexed { at, item ->
                    row("$item", emptyList(), iconButton("TrashIcon", "Remove", danger) {
                        action {
                            writeSetting(id, path, items.filterIndexed { index, _ -> index != at }, true)
                            refresh()
                        }
                    }) { edit(at) }
                }
                if (max == null || items.size < max)
                    row("Add", listOfNotNull(max?.let { "${items.size}/$it" }), icon = "PlusLargeIcon") { edit(null) }
            }
        }
    }

    private fun showColorPicker(id: String, setting: Map<*, *>, path: String, value: String) {
        val (sheet, content) = overlay(true)
        val black = resource("black", 0xFF000000)
        val hsv = FloatArray(3)
        val initial = runCatching { Color.parseColor(value) }.getOrDefault(brand)
        var alpha = Color.alpha(initial)
        var syncing = false
        Color.colorToHSV(initial, hsv)

        val tint = GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, intArrayOf(white, white)).apply {
            cornerRadius = dp(8).toFloat()
        }
        val thumbs = List(2) {
            View(ctx).apply {
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setStroke(dp(3), white)
                }
                elevation = dp(2).toFloat()
            }
        }
        val plane = FrameLayout(ctx).apply {
            background = tint
            addView(View(ctx).apply {
                background = GradientDrawable(
                    GradientDrawable.Orientation.TOP_BOTTOM,
                    intArrayOf(ColorUtils.setAlphaComponent(black, 0), black),
                ).apply { cornerRadius = dp(8).toFloat() }
            }, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(thumbs[0], FrameLayout.LayoutParams(dp(24), dp(24)))
        }
        val spectrum = FrameLayout(ctx).apply {
            background = GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                IntArray(7) { Color.HSVToColor(floatArrayOf(it * 60f, 1f, 1f)) },
            ).apply { cornerRadius = dp(14).toFloat() }
            addView(thumbs[1], FrameLayout.LayoutParams(dp(24), dp(24), Gravity.CENTER_VERTICAL))
        }
        val preview = View(ctx)
        val hex = input("").apply {
            setText(value)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        val error = text("Invalid color", danger, 12f).apply { visibility = View.GONE }
        val update = { typed: Boolean ->
            val color = Color.HSVToColor(alpha, hsv)
            tint.colors = intArrayOf(white, Color.HSVToColor(floatArrayOf(hsv[0], 1f, 1f)))
            thumbs[0].translationX = hsv[1] * (plane.width - dp(24))
            thumbs[0].translationY = (1 - hsv[2]) * (plane.height - dp(24))
            thumbs[1].translationX = hsv[0] / 360f * (spectrum.width - dp(24))
            (thumbs[0].background as GradientDrawable).setColor(ColorUtils.setAlphaComponent(color, 0xFF))
            (thumbs[1].background as GradientDrawable).setColor(Color.HSVToColor(floatArrayOf(hsv[0], 1f, 1f)))
            preview.background = shape(color, 8).apply { setStroke(dp(1), outline) }
            if (!typed) {
                syncing = true
                hex.setText(if (alpha == 0xFF) "#%06X".format(color and 0xFFFFFF) else "#%08X".format(color))
                syncing = false
            }
        }
        val save = button("Save") {
            val digits = hex.text.toString().trim().removePrefix("#").uppercase()
            action {
                writeSetting(id, path, "#$digits", true)
                sheet.dismiss()
                refresh()
            }
        }
        hex.doAfterTextChanged {
            if (syncing) return@doAfterTextChanged
            val digits = it.toString().trim().removePrefix("#")
            val valid = digits.length in setOf(6, 8) && digits.all { char -> char.isDigit() || char.lowercaseChar() in 'a'..'f' }
            error.visibility = if (valid) View.GONE else View.VISIBLE
            hex.background = shape(field, 8).apply { setStroke(dp(1), if (valid) outline else danger) }
            save.isEnabled = valid
            save.alpha = if (valid) 1f else 0.5f
            if (!valid) return@doAfterTextChanged
            val color = Color.parseColor("#$digits")
            alpha = Color.alpha(color)
            Color.colorToHSV(color, hsv)
            update(true)
        }
        plane.setOnTouchListener { view, event ->
            view.parent.requestDisallowInterceptTouchEvent(true)
            hsv[1] = (event.x / view.width).coerceIn(0f, 1f)
            hsv[2] = 1 - (event.y / view.height).coerceIn(0f, 1f)
            update(false)
            true
        }
        spectrum.setOnTouchListener { view, event ->
            view.parent.requestDisallowInterceptTouchEvent(true)
            hsv[0] = (event.x / view.width).coerceIn(0f, 1f) * 359.9f
            update(false)
            true
        }
        plane.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> update(true) }
        spectrum.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> update(true) }

        content.addView(
            text(setting["label"] as String, primary, 18f, semibold).apply { gravity = Gravity.CENTER },
            LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(16) },
        )
        content.addView(plane, LinearLayout.LayoutParams(MATCH_PARENT, dp(180)))
        content.addView(spectrum, LinearLayout.LayoutParams(MATCH_PARENT, dp(28)).apply { topMargin = dp(16) })
        content.addView(LinearLayout(ctx).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(preview, LinearLayout.LayoutParams(dp(40), dp(40)).apply { marginEnd = dp(12) })
            addView(hex, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(16) })
        content.addView(error, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
            topMargin = dp(4)
            marginStart = dp(52)
        })
        content.addView(save, LinearLayout.LayoutParams(MATCH_PARENT, dp(40)).apply { topMargin = dp(16) })
        sheet.show()
    }

    private fun parse(setting: Map<*, *>, type: String, raw: String): Pair<Any?, String?> {
        if (type != "number") {
            val min = (setting["minLength"] as? Number)?.toInt()
            val max = (setting["maxLength"] as? Number)?.toInt()
            val pattern = setting["pattern"] as? String
            return raw to when {
                min != null && raw.length < min -> "Must be at least $min ${if (min == 1) "character" else "characters"}"
                max != null && raw.length > max -> "Must be at most $max ${if (max == 1) "character" else "characters"}"
                pattern != null && !Regex(pattern).containsMatchIn(raw) -> "Invalid format"
                else -> null
            }
        }
        val number = raw.toDoubleOrNull()?.takeIf { it.isFinite() } ?: return null to "Must be a number"
        val integer = setting["integer"] == true
        val min = setting["min"] as? Number
        val max = setting["max"] as? Number
        return (if (number % 1.0 == 0.0) number.toLong() else number) to when {
            integer && number % 1.0 != 0.0 -> "Must be a whole number"
            min != null && number < min.toDouble() -> "Must be at least ${"$min".removeSuffix(".0")}"
            max != null && number > max.toDouble() -> "Must be at most ${"$max".removeSuffix(".0")}"
            else -> null
        }
    }

    private suspend fun settingsFor(plugin: Map<*, *>): List<Map<*, *>> {
        val manifest = plugin["manifest"] as Map<*, *>
        val declared = manifest["settings"] as? List<*>
        if (declared != null) return declared.map { it as Map<*, *> }

        val id = manifest["id"] as String
        val file = pluginStorageFile(id)
        if (!file.isFile) return emptyList()
        val storage = JSONObject(file.readText())
        return storage.keys().asSequence().mapNotNull { key ->
            val value = storage.opt(key)
            val type = when (value) {
                is Boolean -> "switch"
                is Number -> "number"
                is String -> "text"
                else -> return@mapNotNull null
            }
            mapOf(
                "key" to key,
                "type" to type,
                "label" to key.replace(Regex("([a-z0-9])([A-Z])"), "$1 $2")
                    .replace(Regex("[_-]+"), " ").trim()
                    .replaceFirstChar { it.uppercase() },
                "default" to value,
                "value" to value,
            )
        }.toList()
    }

    private suspend fun writeSetting(pluginId: String, key: String, value: Any?, declared: Boolean) {
        if (declared) {
            call("valenced.plugins.settings.write", pluginId, key, value)
            return
        }

        val file = pluginStorageFile(pluginId)
        file.parentFile?.mkdirs()
        val storage = if (file.isFile) JSONObject(file.readText()) else JSONObject()
        storage.put(key, value)
        file.writeText(storage.toString())
    }

    private suspend fun pluginStorageFile(pluginId: String): File {
        val constants = call("valenced.plugins.getConstants") as Map<*, *>
        return File(File(constants["storageRootPath"] as String, pluginId), "storage.json")
    }

    private fun showValenced() = page("Valenced") {
        render {
            section("Valenced", icons = true) {
                for ((name, value, icon) in listOf(
                    Triple("Valenced", info?.get("version") as? String, info?.get("icon") as? String),
                    Triple(
                        "Loader",
                        "${ValencedConstants.LOADER_NAME} (${ValencedConstants.LOADER_VERSION})",
                        "SendMessageIcon",
                    ),
                    Triple("Client", if (phoenixLaunched == true) "Phoenix" else "React Native", "MobilePhoneIcon"),
                    Triple("Framework", xposedFramework, "WrenchIcon"),
                )) row(name, listOfNotNull(value), icon = icon) { copy(name, value) }
                for ((name, url, icon) in listOf(
                    Triple("Discord Server", info?.get("discord") as? String, "ClydeIcon"),
                    Triple("Source Code", info?.get("source") as? String, "PaperIcon"),
                    Triple("License", info?.get("license") as? String, "FileIcon"),
                )) if (!url.isNullOrEmpty()) row(name, if (name == "License") emptyList() else listOf(url), icon = icon) {
                    activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                }
            }
            section("Actions", icons = true) {
                row("Reload App", icon = "RetryIcon") { reloadApp() }

                row("Switch Client", listOf(modes[currentMode()].second), icon = "MobilePhoneIcon") {
                    open(::showClient)
                }
            }
        }
    }

    private fun showClient() = page("Switch Client") {
        val current = currentMode()
        render {
            section(null) {
                modes.forEachIndexed { at, (mode, label) ->
                    row(label, emptyList(), radio(at == current)) {
                        if (at != current) {
                            modeFile.parentFile?.mkdirs()
                            modeFile.writeText(mode)
                            reloadApp()
                        }
                    }
                }
            }
        }
    }

    private fun showRepos() = page(
        "Repositories",
        iconButton("RefreshIcon", "Refresh", primary) {
            action {
                val errors = userRepos().filter { it["enabled"] == true }.mapNotNull { repo ->
                    try {
                        call("valenced.plugins.repos.refresh", repo["url"])
                        null
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Throwable) {
                        "${repo["url"]}: ${e.message}"
                    }
                }
                refresh()
                if (errors.isNotEmpty()) alert(errors.joinToString("\n\n"))
            }
        },
    ) {
        val repos = (call("valenced.plugins.repos.list") as List<*>).map { it as Map<*, *> }

        render {
            val url = input("").apply {
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            }
            val add = button("Add repository") {
                val value = url.text.toString().trim()
                action {
                    try {
                        call("valenced.plugins.repos.set", userRepos() + mapOf("url" to value, "enabled" to true))
                        call("valenced.plugins.repos.refresh", value)
                    } finally {
                        refresh()
                    }
                }
            }.apply {
                isEnabled = false
                alpha = 0.5f
            }
            url.doAfterTextChanged {
                add.isEnabled = !it.isNullOrBlank()
                add.alpha = if (add.isEnabled) 1f else 0.5f
            }

            body.addView(
                text("Repository URL", secondary, 16f),
                LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(8) },
            )
            body.addView(url)
            body.addView(add, LinearLayout.LayoutParams(MATCH_PARENT, dp(40)).apply { topMargin = dp(16) })

            section("Repositories", icons = true) {
                for (repo in repos) {
                    val repoUrl = repo["url"] as String
                    val internal = repo["internal"] == true
                    val name = repo["name"] as? String ?: repoUrl
                    val trailing = if (internal) emptyArray() else arrayOf(
                        toggle(repo["enabled"] == true) { on ->
                            action {
                                try {
                                    call(
                                        "valenced.plugins.repos.set",
                                        userRepos().map { if (it["url"] == repoUrl) it + ("enabled" to on) else it },
                                    )
                                } finally {
                                    refresh()
                                }
                            }
                        },
                    )

                    row(
                        name,
                        listOfNotNull((repo["description"] as? String)?.takeIf { it.isNotEmpty() } ?: repoUrl),
                        *trailing,
                        icon = if (internal) "LockIcon" else "GlobeEarthIcon",
                    ) { open { showBrowse(repoUrl) } }
                }
            }
        }
    }

    private fun showBrowse(only: String?) = page(
        "Browse Plugins",
        iconButton("RefreshIcon", "Refresh", primary) {
            action {
                try {
                    for (repo in userRepos().filter { if (only != null) it["url"] == only else it["enabled"] == true })
                        call("valenced.plugins.repos.refresh", repo["url"])
                } finally {
                    refresh()
                }
            }
        },
    ) {
        val installed = (call("valenced.plugins.list") as List<*>)
            .map { ((it as Map<*, *>)["manifest"] as Map<*, *>)["id"] }.toSet()
        val repos = (call("valenced.plugins.repos.list") as List<*>).map { it as Map<*, *> }
            .filter { if (only != null) it["url"] == only else it["enabled"] == true && it["internal"] != true }

        only?.let { url ->
            title.text = repos.firstOrNull()?.get("name") as? String ?: url
            if (repos.firstOrNull()?.get("internal") != true) actions.addView(iconButton("TrashIcon", "Remove", danger) {
                AlertDialog.Builder(ctx)
                    .setTitle("Remove ${title.text}?")
                    .setNegativeButton(android.R.string.cancel, null)
                    .setPositiveButton("Remove") { _, _ ->
                        action {
                            call("valenced.plugins.repos.set", userRepos().filter { it["url"] != url })
                            back()
                        }
                    }
                    .present(destructive = true)
            }, 0)
        }

        val listings = linkedMapOf<String, Pair<String, Map<*, *>>>()
        for (repo in repos) {
            val url = repo["url"] as String
            for (listing in listings(url)) {
                listing as Map<*, *>
                listings.putIfAbsent(listing["id"] as String, url to listing)
            }
        }

        filtered {
            for ((id, offer) in listings.entries.sortedBy { (it.value.second["name"] as String).lowercase() }) {
                if (id in installed && id !in installedHere) continue
                val (url, listing) = offer
                val name = listing["name"] as String
                val description = listing["description"] as? String
                if (listOfNotNull(name, description, listing["author"] as? String).none { query in it.lowercase() })
                    continue

                val channel = channelOf(listing["channels"] as Map<*, *>, null)
                lateinit var trailing: View
                val start = { target: Map<String, Any?> ->
                    (trailing as? LinearLayout)?.run {
                        minimumWidth = width
                        isEnabled = false
                        removeAllViews()
                        addView(ProgressBar(ctx).apply {
                            indeterminateTintList = ColorStateList.valueOf(white)
                        }, LinearLayout.LayoutParams(dp(16), dp(16)))
                    }
                    action {
                        try {
                            if (install(id, target)) installedHere += id
                        } finally {
                            refresh()
                        }
                    }
                }
                trailing = if (id in installed) text("Installed", secondary)
                else button("Install", "DownloadIcon") {
                    start(mapOf("repo" to url, "channel" to channel, "compatible" to true))
                }.apply { layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, dp(32)) }

                card(name, listing["icon"] as? String, description, trailing) {
                    showBrowseSheet(
                        listing,
                        mapOf("repo" to url, "channel" to channel, "compatible" to true),
                        id in installed,
                        start,
                    )
                }
            }
        }
    }

    private fun showBrowseSheet(
        listing: Map<*, *>,
        target: Map<String, Any?>,
        installed: Boolean,
        install: (Map<String, Any?>) -> Unit,
    ): Unit = action {
        val id = listing["id"] as String
        val name = listing["name"] as String
        val url = target["repo"] as String
        val repoName = (call("valenced.plugins.repos.list") as List<*>)
            .firstOrNull { (it as Map<*, *>)["url"] == url }?.let { (it as Map<*, *>)["name"] as? String }
        val channel = target["channel"] as? String
        val version = target["version"]
            ?: (listing["channels"] as Map<*, *>)[channel] ?: (listing["order"] as List<*>).firstOrNull()
        val (sheet, content) = overlay(true)

        info(
            content,
            name,
            listing["icon"] as? String,
            if (installed) text("Installed", secondary) else button("Install", "DownloadIcon") {
                sheet.dismiss()
                install(target)
            }.apply { layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, dp(32)) },
            listing["author"] as? String,
            listing["contributors"] as? List<*>,
            null,
            listing["description"] as? String,
        )
        section("Source", icons = true, into = content) {
            row("Repository", listOf(repoName?.let { "$it ($url)" } ?: url), chevron(), icon = "GlobeEarthIcon") {
                sheet.dismiss()
                open {
                    showRepoPicker(id, name, url) { picked, offer ->
                        back()
                        showBrowseSheet(offer, retarget(target, picked, offer), installed, install)
                    }
                }
            }
            row(
                if (channel != null) "Channel" else "Version",
                listOf(
                    when {
                        channel == null -> "v$version"
                        target["compatible"] == true -> "$channel • up to v$version"
                        else -> "$channel (exact) • v$version"
                    },
                ),
                chevron(),
                icon = "LocationIcon",
            ) {
                sheet.dismiss()
                open {
                    showRefPicker(id, url, target) { picked ->
                        back()
                        showBrowseSheet(listing, picked, installed, install)
                    }
                }
            }
        }
        section("Advanced", icons = true, into = content) {
            row("ID", listOf(id), icon = "IdIcon") { copy("ID", id) }
        }
        sheet.show()
    }

    private fun showRepoPicker(
        id: String,
        name: String,
        selected: String?,
        onSelect: suspend (String, Map<*, *>) -> Unit,
    ) = page(
        "Select repository",
        iconButton("RefreshIcon", "Refresh", primary) {
            action {
                try {
                    for (repo in userRepos().filter { it["enabled"] == true })
                        call("valenced.plugins.repos.refresh", repo["url"])
                } finally {
                    refresh()
                }
            }
        },
    ) {
        val offers = (call("valenced.plugins.repos.list") as List<*>).map { it as Map<*, *> }
            .filter { it["enabled"] == true && it["internal"] != true }
            .mapNotNull { repo ->
                val listing = try {
                    listings(repo["url"] as String).firstOrNull { (it as Map<*, *>)["id"] == id }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Throwable) {
                    null
                }
                (listing as? Map<*, *>)?.let { repo to it }
            }

        render {
            if (offers.isEmpty()) section(null) { row("No repositories serve this plugin") }
            else section("Repositories serving $name") {
                for ((repo, listing) in offers) {
                    val url = repo["url"] as String
                    val repoName = repo["name"] as? String
                    row(repoName ?: url, listOfNotNull(url.takeIf { repoName != null }), radio(url == selected)) {
                        if (url != selected) action { onSelect(url, listing) }
                    }
                }
            }
        }
    }

    private fun showRefPicker(
        id: String,
        repo: String,
        selected: Map<String, Any?>,
        onSelect: suspend (Map<String, Any?>) -> Unit,
    ) = page(
        "Select a channel or version",
        iconButton("RefreshIcon", "Refresh", primary) {
            action {
                try {
                    call("valenced.plugins.repos.refresh", repo)
                } finally {
                    refresh()
                }
            }
        },
    ) {
        val listing = listings(repo).firstOrNull { (it as Map<*, *>)["id"] == id } as? Map<*, *>

        render {
            if (listing == null) {
                section(null) { row("This repository no longer serves this plugin") }
                return@render
            }
            val channels = listing["channels"] as Map<*, *>
            val versions = listing["versions"] as Map<*, *>
            val pick = { target: Map<String, Any?> -> if (target != selected) action { onSelect(target) } }

            if (channels.isNotEmpty()) for (compatible in listOf(true, false))
                section(if (compatible) "Newest compatible" else "Follow a channel") {
                    for ((channel, version) in channels) row(
                        channel as String,
                        listOf(if (compatible) "Up to v$version" else "v$version"),
                        radio(selected["channel"] == channel && (selected["compatible"] == true) == compatible),
                    ) { pick(mapOf("repo" to repo, "channel" to channel, "compatible" to compatible)) }
                }
            if (versions.isNotEmpty()) section("Stay on a version") {
                for (version in listing["order"] as List<*>) row(
                    "v$version",
                    listOf((channels.filterValues { it == version }.keys.map { "$it" } +
                            bytes((versions[version] as Map<*, *>)["size"] as Number)).joinToString(" • ")),
                    radio(selected["version"] == version),
                ) { pick(mapOf("repo" to repo, "version" to version)) }
            }
        }
    }

    private suspend fun install(id: String, target: Map<String, Any?>, note: String? = null): Boolean {
        val plan = call("valenced.plugins.planInstall", id, mapOf("targets" to mapOf(id to target))) as Map<*, *>
        val planned = (plan["actions"] as List<*>).map { it as Map<*, *> }
        val warnings = (plan["warnings"] as List<*>).mapNotNull { (it as? Map<*, *>)?.get("message") }
        if (warnings.isNotEmpty()) Toast.makeText(ctx, warnings.joinToString("\n"), Toast.LENGTH_LONG).show()
        if (planned.isEmpty()) {
            Toast.makeText(ctx, "Plugins already installed, or no versions compatible.", Toast.LENGTH_SHORT).show()
            return true
        }

        val repos = (call("valenced.plugins.repos.list") as List<*>).map { it as Map<*, *> }
        val items = planned.map { action ->
            action to listings(action["repo"] as String).firstOrNull { (it as Map<*, *>)["id"] == action["id"] } as? Map<*, *>
        }
        val names = items.associate { (action, listing) -> action["id"] to (listing?.get("name") as? String ?: "${action["id"]}") }
        val roots = planned.filter { (it["dependents"] as? List<*>).isNullOrEmpty() }
        val title = names[(roots.firstOrNull() ?: planned.first())["id"]]
        val message = (listOfNotNull(if (planned.size > roots.size) "$title requires extra plugins." else null) +
                planned.filter { it["channelVersion"] != null }.map {
                    "${names[it["id"]]} v${it["channelVersion"]} doesn't work with your setup, so v${it["version"]} will be installed instead."
                } + listOfNotNull(note)).joinToString("\n\n").ifEmpty { null }

        if (!confirm(if (roots.size > 1) "Install ${roots.size} plugins?" else "Install $title?", message, "Install") { modal ->
                modal.addView(View(ctx), LinearLayout.LayoutParams(0, dp(12)))
                for ((action, listing) in items) card(
                    names[action["id"]]!!,
                    listing?.get("icon") as? String,
                    buildSpannedString {
                        inSpans(ImageSpan(icon("GlobeEarthIcon", secondary)!!.apply { setBounds(0, 0, dp(14), dp(14)) })) {
                            append(" ")
                        }
                        inSpans(AbsoluteSizeSpan(14, true)) {
                            color(secondary) {
                                append(" " + (repos.firstOrNull { it["url"] == action["repo"] }?.get("name") ?: action["repo"]))
                            }
                        }
                        (listing?.get("description") as? String)?.takeIf { it.isNotEmpty() }?.let { append("\n$it") }
                    },
                    text(
                        ((action["replaces"] as? String)?.let { "v$it to " } ?: "") +
                                "v${action["version"]} • ${bytes(action["size"] as Number)}",
                        secondary,
                        13f,
                    ),
                    modal,
                )
            }
        ) return false

        call("valenced.plugins.install", plan)
        dirty = true
        Toast.makeText(ctx, "Installed $title", Toast.LENGTH_SHORT).show()
        return true
    }

    private fun open(page: () -> Unit) {
        stack.addLast(page)
        display(page)
    }

    private fun back() {
        stack.removeLastOrNull()
        display(stack.lastOrNull() ?: return dialog.dismiss())
    }

    private fun display(page: () -> Unit) {
        onQuery = null
        search.setText("")
        toolbar.visibility = View.GONE
        filterButton.visibility = View.GONE
        fab.visibility = View.GONE
        body.removeAllViews()
        body.addView(
            ProgressBar(ctx).apply { indeterminateTintList = ColorStateList.valueOf(brand) },
            LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                topMargin = dp(32)
            },
        )
        scroll.scrollTo(0, 0)
        page()
    }

    private fun refresh() {
        stack.lastOrNull()?.invoke()
    }

    private fun page(name: String, vararg buttons: View, load: suspend () -> Unit) {
        title.text = name
        actions.removeAllViews()
        for (button in buttons) actions.addView(button)

        pageJob?.cancel()
        pageJob = scope.launch {
            try {
                load()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                body.removeAllViews()
                alert(e.message ?: e.toString())
            }
        }
    }

    private fun render(build: () -> Unit) {
        val y = scroll.scrollY
        body.removeAllViews()
        body.setPadding(
            dp(16),
            dp(if (toolbar.visibility == View.VISIBLE) 20 else 24),
            dp(16),
            dp(if (fab.visibility == View.VISIBLE) 88 else 40),
        )
        build()
        scroll.post { scroll.scrollTo(0, y) }
    }

    private fun filtered(build: () -> Unit) {
        toolbar.visibility = View.VISIBLE
        onQuery = { render(build) }
        render(build)
    }

    private fun action(block: suspend () -> Unit) {
        scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                alert(e.message ?: e.toString())
            }
        }
    }

    private suspend fun call(name: String, vararg args: Any?): Any? {
        val response = suspendCancellableCoroutine { cont ->
            ValencedBridgeRegistry.dispatchAsync(name, args.toList()) { cont.resume(it) }
        }
        val payload = response["result"] as? Map<*, *>
        val error = response["error"] ?: payload?.get("error")
        if (error != null) throw Exception((error as? Map<*, *>)?.get("message") as? String ?: error.toString())
        return payload?.get("result")
    }

    private suspend fun userRepos(): List<Map<String, Any?>> =
        (call("valenced.plugins.repos.list") as List<*>).map { it as Map<*, *> }
            .filter { it["internal"] != true }
            .map { mapOf("url" to it["url"], "enabled" to it["enabled"]) }

    private fun alert(message: String) {
        if (dialog.isShowing) AlertDialog.Builder(ctx)
            .setMessage(message)
            .setPositiveButton(android.R.string.ok, null)
            .present()
    }

    private fun AlertDialog.Builder.present(destructive: Boolean = false): AlertDialog = show().apply {
        window?.setBackgroundDrawable(InsetDrawable(shape(ColorUtils.compositeColors(surface, backdrop), 16), dp(16)))
        findViewById<TextView>(ctx.resources.getIdentifier("alertTitle", "id", "android"))?.run {
            setTextColor(primary)
            typeface = semibold
        }
        findViewById<TextView>(android.R.id.message)?.run {
            setTextColor(secondary)
            typeface = medium
        }
        getButton(DialogInterface.BUTTON_POSITIVE)?.run {
            setTextColor(if (destructive) danger else brand)
            typeface = semibold
            isAllCaps = false
        }
        getButton(DialogInterface.BUTTON_NEGATIVE)?.run {
            setTextColor(primary)
            typeface = semibold
            isAllCaps = false
        }
    }

    private fun overlay(bottom: Boolean): Pair<Dialog, LinearLayout> {
        val sheet = Dialog(
            activity,
            if (dark) android.R.style.Theme_DeviceDefault_NoActionBar
            else android.R.style.Theme_DeviceDefault_Light_NoActionBar,
        )
        overlays += sheet
        sheet.setOnDismissListener { overlays -= sheet }
        val content = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        val panel = LinearLayout(ctx)
        val root = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            gravity = if (bottom) Gravity.BOTTOM else Gravity.CENTER
            setBackgroundColor(scrim)
            setOnClickListener { sheet.cancel() }
            addView(panel.apply {
                orientation = LinearLayout.VERTICAL
                isClickable = true
                if (bottom) {
                    background = GradientDrawable().apply {
                        cornerRadii = FloatArray(8) { if (it < 4) dp(24).toFloat() else 0f }
                        setColor(backdrop)
                    }
                    addView(
                        View(ctx).apply { background = shape(ColorUtils.setAlphaComponent(secondary, 0x66), 2) },
                        LinearLayout.LayoutParams(dp(36), dp(4)).apply {
                            gravity = Gravity.CENTER_HORIZONTAL
                            topMargin = dp(10)
                        },
                    )
                } else background = shape(ColorUtils.compositeColors(surface, backdrop), 16)
                addView(object : ScrollView(ctx) {
                    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) = super.onMeasure(
                        widthMeasureSpec,
                        if (bottom) MeasureSpec.makeMeasureSpec(
                            (resources.displayMetrics.heightPixels * 0.66).toInt(),
                            MeasureSpec.AT_MOST,
                        ) else heightMeasureSpec,
                    )
                }.apply { addView(content) }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            val side = if (bottom) 0 else dp(16)
            view.setPadding(
                bars.left + side,
                bars.top + dp(if (bottom) 56 else 16),
                bars.right + side,
                if (bottom) keyboard else maxOf(bars.bottom, keyboard) + dp(16),
            )
            val inner = dp(if (bottom) 16 else 24)
            content.setPadding(inner, inner, inner, inner + if (bottom && keyboard == 0) bars.bottom else 0)
            WindowInsetsCompat.CONSUMED
        }

        sheet.setContentView(root)
        sheet.window?.let { window ->
            window.setLayout(MATCH_PARENT, MATCH_PARENT)
            window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            WindowCompat.setDecorFitsSystemWindows(window, false)
            @Suppress("DEPRECATION")
            window.statusBarColor = Color.TRANSPARENT
            @Suppress("DEPRECATION")
            window.navigationBarColor = Color.TRANSPARENT
            WindowCompat.getInsetsController(window, window.decorView).run {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
        sheet.setOnShowListener {
            root.alpha = 0f
            root.animate().alpha(1f).setDuration(150).start()
            if (bottom) panel.post {
                panel.translationY = panel.height.toFloat()
                panel.animate().translationY(0f).setDuration(250).start()
            }
        }
        return sheet to content
    }

    private suspend fun confirm(
        title: String,
        message: CharSequence?,
        label: String,
        destructive: Boolean = false,
        build: (LinearLayout) -> Unit = {},
    ) = suspendCancellableCoroutine { cont ->
        val (modal, content) = overlay(false)
        content.addView(text(title, primary, 20f, semibold).apply { gravity = Gravity.CENTER })
        if (message != null) content.addView(
            text(message, primary, 16f).apply { gravity = Gravity.CENTER },
            LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(8) },
        )
        build(content)
        for ((index, name) in listOf(label, "Cancel").withIndex()) content.addView(LinearLayout(ctx).apply {
            gravity = Gravity.CENTER
            background = RippleDrawable(
                ColorStateList.valueOf(pressed),
                shape(if (index == 1) surface else if (destructive) critical else brand, 8),
                null,
            )
            addView(text(name, if (index == 1) primary else white, 16f, semibold))
            setOnClickListener {
                modal.dismiss()
                if (cont.isActive) cont.resume(index == 0)
            }
        }, LinearLayout.LayoutParams(MATCH_PARENT, dp(40)).apply { topMargin = dp(if (index == 0) 24 else 12) })
        modal.setOnCancelListener { if (cont.isActive) cont.resume(false) }
        cont.invokeOnCancellation { modal.dismiss() }
        modal.show()
    }

    private fun info(
        into: LinearLayout,
        name: String,
        icon: String?,
        trailing: View?,
        author: String?,
        contributors: List<*>?,
        version: String?,
        description: String?,
    ) {
        into.addView(LinearLayout(ctx).apply {
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(32)
            addView(
                ImageView(ctx).apply { setImageDrawable(icon(icon, primary) ?: icon("PuzzlePieceIcon", primary)) },
                LinearLayout.LayoutParams(dp(20), dp(20)).apply { marginEnd = dp(8) },
            )
            addView(text(name, primary, 20f, semibold), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            if (trailing != null) addView(
                trailing,
                LinearLayout.LayoutParams(trailing.layoutParams ?: ViewGroup.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
                    .apply { marginStart = dp(8) },
            )
        })
        val names = (listOfNotNull(author) + contributors.orEmpty())
            .joinToString(", ") { "$it".substringBefore('<').substringBefore('(').trim() }
        val linked = !contributors.isNullOrEmpty() || author?.contains(Regex("[<(]")) == true
        into.addView(text(buildSpannedString {
            append("by ")
            if (!linked) append(names)
            else color(link) { bold { append(names) } }
            if (version != null) append(" • $version")
        }, secondary, 19f).apply {
            if (linked) setOnClickListener {
                showContributors(name, listOfNotNull(author) + contributors.orEmpty().map { "$it" })
            }
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(6) })
        if (!description.isNullOrEmpty()) into.addView(
            text(description, primary, 14.5f).apply { TextViewCompat.setLineHeight(this, dp(17)) },
            LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(4) },
        )
    }

    private fun showContributors(pluginName: String, people: List<String>) {
        val (sheet, content) = overlay(true)
        val entry = Regex("""^(?:<(\d{17,20})>|\(((?:https?://|mailto:)[^()\s]+)(?:\s+"([^"()]+)")?\))\s*""", RegexOption.IGNORE_CASE)
        val contributors = people.map { raw ->
            val start = raw.indexOfFirst { it == '<' || it == '(' }
            val ids = mutableListOf<String>()
            val links = mutableListOf<Pair<String, String?>>()
            var rest = if (start < 0) "" else raw.substring(start)
            while (rest.isNotEmpty()) {
                val match = entry.find(rest) ?: break
                val (id, url, label) = match.destructured
                if (id.isNotEmpty()) ids += id else links += url to label.ifEmpty { null }
                rest = rest.substring(match.value.length)
            }
            val name = (if (start < 0) raw else raw.substring(0, start)).trim()
            if (rest.isNotEmpty() || name.isEmpty()) Triple(raw, emptyList(), emptyList())
            else Triple(name, ids.distinct().take(5), links.distinctBy { it.first }.take(5))
        }

        content.addView(
            text("Contributors of $pluginName", primary, 18f, semibold).apply { gravity = Gravity.CENTER },
            LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(20) },
        )
        val tabs = LinearLayout(ctx).apply {
            background = shape(field, 20)
            setPadding(dp(4), dp(4), dp(4), dp(4))
        }
        val page = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        val select = { index: Int ->
            for (at in 0 until tabs.childCount) (tabs.getChildAt(at) as TextView).run {
                background = if (at == index) shape(ColorUtils.compositeColors(surface, backdrop), 16) else null
                setTextColor(if (at == index) primary else secondary)
            }
            page.removeAllViews()
            val (name, ids, links) = contributors[index]
            if (ids.isEmpty() && links.isEmpty()) page.addView(text("No contact information.", secondary, 16f))
            else section("Contacts for $name", icons = true, into = page) {
                for (id in ids) row("Discord", listOf(id), chevron(), icon = "ClydeIcon") {
                    overlays.toList().forEach(Dialog::dismiss)
                    dialog.dismiss()
                    activity.startActivity(
                        Intent(Intent.ACTION_VIEW, Uri.parse("https://discord.com/users/$id")).setPackage(activity.packageName),
                    )
                }
                for ((url, label) in links) {
                    val shown = url.replace(Regex("^(?:https?://|mailto:)", RegexOption.IGNORE_CASE), "").removeSuffix("/")
                    row(label ?: shown, listOfNotNull(shown.takeIf { label != null }), chevron(), icon = "LinkIcon") {
                        activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    }
                }
            }
        }
        if (contributors.size > 1) {
            contributors.forEachIndexed { index, (name) ->
                tabs.addView(
                    text(name, secondary, 14f, semibold).apply {
                        gravity = Gravity.CENTER
                        maxLines = 1
                        setPadding(dp(12), dp(8), dp(12), dp(8))
                        setOnClickListener { select(index) }
                    },
                    if (contributors.size > 3) LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT)
                    else LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f),
                )
            }
            content.addView(
                if (contributors.size > 3) HorizontalScrollView(ctx).apply {
                    isHorizontalScrollBarEnabled = false
                    addView(tabs)
                } else tabs,
                LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(20) },
            )
        }
        content.addView(page)
        select(0)
        sheet.show()
    }

    private fun chevron() = ImageView(ctx).apply {
        setImageDrawable(icon("ChevronSmallRightIcon", secondary))
        layoutParams = ViewGroup.LayoutParams(dp(24), dp(24))
    }

    private fun copy(label: String, value: String?) {
        (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
            .setPrimaryClip(ClipData.newPlainText(label, value))
        Toast.makeText(ctx, "Copied to clipboard", Toast.LENGTH_SHORT).show()
    }

    private suspend fun listings(url: String) = try {
        call("valenced.plugins.repos.listPlugins", url)
    } catch (e: CancellationException) {
        throw e
    } catch (_: Throwable) {
        call("valenced.plugins.repos.refresh", url)
        call("valenced.plugins.repos.listPlugins", url)
    } as List<*>

    private fun channelOf(channels: Map<*, *>, preferred: Any?) = when {
        preferred in channels -> preferred as String
        "latest" in channels -> "latest"
        else -> channels.keys.map { it as String }.minOrNull() ?: "latest"
    }

    private fun retarget(target: Map<String, Any?>, url: String, listing: Map<*, *>): Map<String, Any?> {
        val channels = listing["channels"] as Map<*, *>
        val version = target["version"]
            ?: return target + mapOf("repo" to url, "channel" to channelOf(channels, target["channel"]))
        if (version in listing["versions"] as Map<*, *>) return target + ("repo" to url)
        val fallback = channelOf(channels, null)
        return (channels[fallback] ?: (listing["order"] as List<*>).firstOrNull())
            ?.let { mapOf("repo" to url, "version" to it) }
            ?: mapOf("repo" to url, "channel" to fallback, "compatible" to true)
    }

    private fun versionOf(manifest: Map<*, *>): String {
        val version = manifest["version"] as Map<*, *>
        return (version["nums"] as List<*>).joinToString(".") { "${(it as Number).toLong()}" } +
                ((version["label"] as? String)?.let { "-$it" } ?: "")
    }

    private fun bytes(size: Number) = size.toLong().let {
        when {
            it < 1024 -> "$it B"
            it < 1024 * 1024 -> "%.1f KB".format(it / 1024.0)
            else -> "%.1f MB".format(it / (1024.0 * 1024))
        }
    }

    private fun card(
        name: String,
        icon: String?,
        description: CharSequence?,
        trailing: View?,
        into: LinearLayout = body,
        onClick: (() -> Unit)? = null,
    ) {
        into.addView(LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(12), dp(12), dp(12))
            background = RippleDrawable(ColorStateList.valueOf(pressed), shape(surface, 16), null)
            onClick?.let { setOnClickListener { it() } }

            addView(LinearLayout(ctx).apply {
                gravity = Gravity.CENTER_VERTICAL
                minimumHeight = dp(32)
                addView(
                    ImageView(ctx).apply { setImageDrawable(icon(icon, primary) ?: icon("PuzzlePieceIcon", primary)) },
                    LinearLayout.LayoutParams(dp(20), dp(20)).apply { marginEnd = dp(8) },
                )
                addView(text(name, primary, 20f, semibold), LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
                if (trailing != null) addView(
                    trailing,
                    LinearLayout.LayoutParams(trailing.layoutParams ?: ViewGroup.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
                        .apply { marginStart = dp(8) },
                )
            })
            if (!description.isNullOrEmpty()) addView(
                text(description, primary, 14.5f).apply { TextViewCompat.setLineHeight(this, dp(17)) },
                LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
                    marginStart = dp(28)
                    topMargin = dp(2)
                },
            )
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(12) })
    }

    private fun section(name: String?, icons: Boolean = false, into: LinearLayout = body, build: () -> Unit) {
        val spaced = into.childCount > 0
        if (name != null) into.addView(
            text(name, secondary, 16f),
            LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
                if (spaced) topMargin = dp(24)
                bottomMargin = dp(8)
            },
        )
        group = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = shape(surface, 12)
            clipToOutline = true
            showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
            dividerDrawable = InsetDrawable(
                GradientDrawable().apply {
                    setColor(divider)
                    setSize(0, dp(1))
                },
                dp(if (icons) 56 else 16),
                0,
                0,
                0,
            )
        }
        into.addView(group, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
            if (name == null && spaced) topMargin = dp(24)
        })
        build()
        group = null
    }

    private fun row(
        title: String,
        lines: List<CharSequence> = emptyList(),
        vararg trailing: View,
        icon: String? = null,
        tint: Int = primary,
        onClick: (() -> Unit)? = null,
    ): View {
        val image = icon(icon, tint)
        return LinearLayout(ctx).apply {
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(56)
            setPadding(dp(if (image != null) 12 else 16), dp(12), dp(12), dp(12))
            if (onClick != null) {
                background = StateListDrawable().apply {
                    addState(intArrayOf(android.R.attr.state_pressed), ColorDrawable(pressed))
                }
                setOnClickListener { onClick() }
            }

            if (image != null) addView(
                ImageView(ctx).apply { setImageDrawable(image) },
                LinearLayout.LayoutParams(dp(24), dp(24)).apply { setMargins(dp(4), dp(4), dp(16), dp(4)) },
            )
            addView(LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                addView(text(title, tint, 16f))
                for (line in lines) addView(text(line, secondary, 12f).apply {
                    maxLines = 2
                    ellipsize = TextUtils.TruncateAt.END
                })
            }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
            for (view in trailing) addView(
                view,
                LinearLayout.LayoutParams(view.layoutParams ?: ViewGroup.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
                    .apply { marginStart = dp(16) },
            )
        }.also { group!!.addView(it, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)) }
    }

    private fun radio(selected: Boolean) = FrameLayout(ctx).apply {
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            if (selected) setColor(brand)
            else setStroke((1.5f * activity.resources.displayMetrics.density).toInt(), ColorUtils.setAlphaComponent(secondary, 0x8C))
        }
        if (selected) addView(View(ctx).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(white)
            }
        }, FrameLayout.LayoutParams(dp(8), dp(8), Gravity.CENTER))
        layoutParams = ViewGroup.LayoutParams(dp(24), dp(24))
    }

    private fun toggle(on: Boolean, onChange: (Boolean) -> Unit): View {
        val track = GradientDrawable().apply { cornerRadius = dp(16).toFloat() }
        val knob = View(ctx).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(white)
            }
        }
        var checked = on
        val paint = {
            track.setColor(if (checked) brand else field)
            track.setStroke(dp(1), if (checked) brand else outline)
        }
        paint()
        knob.translationX = if (checked) dp(28).toFloat() else 0f

        return FrameLayout(ctx).apply {
            background = track
            setPadding(dp(4), dp(4), dp(4), dp(4))
            addView(knob, FrameLayout.LayoutParams(dp(20), dp(20), Gravity.CENTER_VERTICAL))
            layoutParams = ViewGroup.LayoutParams(dp(56), dp(28))
            setOnClickListener {
                checked = !checked
                paint()
                knob.animate().translationX(if (checked) dp(28).toFloat() else 0f).setDuration(150).start()
                isEnabled = false
                onChange(checked)
            }
        }
    }

    private fun button(label: String, icon: String? = null, onClick: () -> Unit) = LinearLayout(ctx).apply {
        gravity = Gravity.CENTER
        setPadding(dp(12), 0, dp(12), 0)
        background = RippleDrawable(ColorStateList.valueOf(pressed), shape(brand, 8), null)
        setOnClickListener { onClick() }
        icon(icon, white)?.let { drawable ->
            addView(ImageView(ctx).apply { setImageDrawable(drawable) }, LinearLayout.LayoutParams(dp(16), dp(16)).apply {
                marginEnd = dp(6)
            })
        }
        addView(text(label, white, 14f, semibold))
    }

    private fun iconButton(icon: String, description: String, tint: Int, onClick: () -> Unit) = ImageView(ctx).apply {
        scaleType = ImageView.ScaleType.CENTER
        setImageDrawable(icon(icon, tint))
        contentDescription = description
        background = RippleDrawable(ColorStateList.valueOf(pressed), null, null)
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(dp(40), dp(40))
    }

    private fun input(hint: String) = EditText(ctx).apply {
        isSingleLine = true
        textSize = 16f
        typeface = medium
        this.hint = hint
        setTextColor(primary)
        setHintTextColor(secondary)
        minHeight = dp(40)
        setPadding(dp(12), dp(8), dp(12), dp(8))
        background = shape(field, 8).apply { setStroke(dp(1), outline) }
    }

    private fun text(value: CharSequence, color: Int, size: Float = 14f, face: Typeface = medium) = TextView(ctx).apply {
        text = value
        textSize = size
        typeface = face
        setTextColor(color)
    }

    private fun shape(color: Int, radius: Int) = GradientDrawable().apply {
        cornerRadius = dp(radius).toFloat()
        setColor(color)
    }

    // RN design icons from the density split. Plugin data URLs stay untinted, like RN.
    private fun icon(name: String?, tint: Int): Drawable? = if (name?.startsWith("data:") == true)
        Base64.decode(name.substringAfter(","), Base64.DEFAULT)
            .let { BitmapFactory.decodeByteArray(it, 0, it.size) }
            ?.let { BitmapDrawable(ctx.resources, it).apply { if (name == info?.get("icon")) setTint(tint) } }
    else name
        ?.let {
            ctx.resources.getIdentifier(
                "design_components_icon_native_redesign_generated_images_${it.lowercase()}",
                "drawable",
                ctx.packageName,
            )
        }
        ?.takeIf { it != 0 }
        ?.let { ctx.getDrawable(it)?.mutate()?.apply { setTint(tint) } }

    private fun currentMode(): Int {
        val mode = readForce(activity.applicationInfo.dataDir).name.lowercase()
        return modes.indexOfFirst { it.first == mode }
    }

    private fun resource(name: String, fallback: Long) =
        activity.resources.getIdentifier(name, "color", activity.packageName).takeIf { it != 0 }
            ?.let { activity.getColor(it) } ?: fallback.toInt()

    private fun color(name: String, fallback: Long) = ((theme?.get(name) as? Number)?.toLong() ?: fallback).toInt()

    private fun font(name: String) = try {
        Typeface.createFromAsset(activity.assets, "fonts/$name.ttf")
    } catch (_: RuntimeException) {
        Typeface.DEFAULT
    }

    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density).toInt()
}

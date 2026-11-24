import java.io.ByteArrayOutputStream
import javax.inject.Inject

plugins {
    base
}

/**
 * Runs Deno from `PATH` with a minimal environment, so the host environment can't change the output.
 * Fails unless Deno matches [denoVersion].
 */
@CacheableTask
abstract class DenoTask @Inject constructor(private val exec: ExecOperations) : DefaultTask() {
    @get:Input
    abstract val denoVersion: Property<String>

    @get:Input
    abstract val arguments: ListProperty<String>

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    /** Stamps the bundle's version, so it's an input even though the sources may be unchanged. */
    @get:Input
    @get:Optional
    abstract val commit: Property<String>

    @get:OutputDirectory
    @get:Optional
    abstract val outputDir: DirectoryProperty

    @get:Internal
    abstract val workDir: DirectoryProperty

    @TaskAction
    fun run() {
        val versionOutput = ByteArrayOutputStream()
        exec.exec {
            commandLine("deno", "--version")
            standardOutput = versionOutput
        }
        val found = versionOutput.toString().lineSequence().first().split(' ').getOrNull(1)
        check(found == denoVersion.get()) {
            "Deno ${denoVersion.get()} is required (bundle/.dvmrc), but found $found"
        }

        exec.exec {
            workingDir = this@DenoTask.workDir.get().asFile
            commandLine(listOf("deno") + arguments.get())
            environment = System.getenv().filterKeys { it in PASSTHROUGH_ENV } + ("NO_COLOR" to "1")
        }
    }

    companion object {
        /** What Deno needs to find itself, its cache and a temp directory. */
        private val PASSTHROUGH_ENV = sortedSetOf(
            String.CASE_INSENSITIVE_ORDER,
            "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot",
            "XDG_CACHE_HOME", "DENO_DIR", "TMPDIR", "TEMP", "TMP",
        )
    }
}

val pinnedDenoVersion = providers.fileContents(layout.projectDirectory.file(".dvmrc")).asText.map { it.trim() }
val offline = gradle.startParameter.isOffline
val cachedOnly = if (offline) listOf("--cached-only") else emptyList()

val bundleSources = files(
    "src", "lib", "shims", "scripts", "types",
    "package.json", "deno.json", "deno.lock", "tsconfig.json", "build.env",
).asFileTree.matching { exclude("**/node_modules/**") }

val bundleCommit = providers.exec {
    commandLine("git", "log", "-1", "--format=%h", "--abbrev=7", "--", ".")
    workingDir = layout.projectDirectory.asFile
}.standardOutput.asText.map { it.trim() }

val installDependencies = tasks.register<DenoTask>("installDependencies") {
    description = "Installs the bundle's npm dependencies from the frozen lockfile."
    denoVersion = pinnedDenoVersion
    workDir = layout.projectDirectory
    arguments = listOf("install", "--frozen") + cachedOnly
}

fun registerBundle(variant: String, dev: Boolean, phoenix: Boolean = false): TaskProvider<DenoTask> {
    val name = variant.replaceFirstChar(Char::uppercase) + if (phoenix) "Phoenix" else ""
    val out = if (phoenix) "bundle/phoenix/$variant" else "bundle/$variant"

    return tasks.register<DenoTask>("assemble${name}Bundle") {
        group = "build"
        description = if (phoenix) "Builds the $variant Phoenix bundle and its manifest."
            else "Builds the $variant Hermes bundle and its manifest."
        dependsOn(installDependencies)
        denoVersion = pinnedDenoVersion
        workDir = layout.projectDirectory
        sources.from(bundleSources)
        commit = bundleCommit
        outputDir = layout.buildDirectory.dir(out)
        arguments = listOf("run", "--permission-set=build") + cachedOnly +
            listOf("scripts/build.ts", "--reproducible", "--out", "build/$out") +
            (if (phoenix) listOf("--target", "phoenix") else emptyList()) +
            (if (dev) listOf("--dev") else emptyList())
    }
}

val assembleDebugBundle = registerBundle("debug", dev = true)
val assembleReleaseBundle = registerBundle("release", dev = false)
val assembleDebugPhoenixBundle = registerBundle("debug", dev = true, phoenix = true)
val assembleReleasePhoenixBundle = registerBundle("release", dev = false, phoenix = true)

// Both builds regenerate dist/assets/generated. The Phoenix target never touches it.
assembleReleaseBundle { mustRunAfter(assembleDebugBundle) }

val testBundle = tasks.register<DenoTask>("testBundle") {
    group = "verification"
    description = "Runs the bundle's tests."
    dependsOn(installDependencies)
    denoVersion = pinnedDenoVersion
    workDir = layout.projectDirectory
    arguments = listOf("run", "test")
}

tasks.named("assemble") {
    dependsOn(
        assembleDebugBundle,
        assembleReleaseBundle,
        assembleDebugPhoenixBundle,
        assembleReleasePhoenixBundle,
    )
}
tasks.named("check") { dependsOn(testBundle) }

configurations.consumable("debugBundle")
configurations.consumable("releaseBundle")
configurations.consumable("debugPhoenixBundle")
configurations.consumable("releasePhoenixBundle")

artifacts {
    add("debugBundle", assembleDebugBundle.flatMap { it.outputDir }) { builtBy(assembleDebugBundle) }
    add("releaseBundle", assembleReleaseBundle.flatMap { it.outputDir }) { builtBy(assembleReleaseBundle) }
    add("debugPhoenixBundle", assembleDebugPhoenixBundle.flatMap { it.outputDir }) { builtBy(assembleDebugPhoenixBundle) }
    add("releasePhoenixBundle", assembleReleasePhoenixBundle.flatMap { it.outputDir }) { builtBy(assembleReleasePhoenixBundle) }
}

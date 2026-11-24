import java.net.URI
import java.security.MessageDigest
import javax.inject.Inject

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(libs.versions.javaVersion.get().toInt())
}

/** The quickjs-ng tree the Phoenix runtime links against, filled by [FetchQuickjs]. */
val quickjsDir = layout.projectDirectory
    .dir("native/third_party/quickjs-${libs.versions.quickjsNg.get()}")
    .asFile.invariantSeparatorsPath

android {
    namespace = "app.valenced.xposed"
    compileSdk = libs.versions.compileSdk.get().toInt()
    ndkVersion = libs.versions.ndk.get()

    defaultConfig {
        applicationId = "app.valenced.xposed"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 10300
        versionName = "1.3.0"

        externalNativeBuild {
            cmake {
                arguments += listOf("-DQUICKJS_DIR=$quickjsDir", "-DANDROID_STL=none")
                // Without this AGP builds every target quickjs-ng declares, including its tools.
                targets += "valenced_phoenix"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("native/CMakeLists.txt")
            version = libs.versions.cmake.get()
        }
    }

    sourceSets {
        named("main") {
            kotlin.directories += "src/main/kotlin"
        }
    }

    // Release signing is provided by CI through the environment. Without it, release builds are unsigned.
    val keystoreFile = providers.environmentVariable("KEYSTORE_FILE").orNull?.takeIf { it.isNotBlank() }
    if (keystoreFile != null) {
        signingConfigs {
            create("release") {
                storeFile = file(keystoreFile)
                storePassword = providers.environmentVariable("KEYSTORE_PASSWORD").get()
                keyAlias = providers.environmentVariable("KEY_ALIAS").get()
                keyPassword = providers.environmentVariable("KEY_PASSWORD").get()
            }
        }
    }

    buildTypes {
        debug {
            isDebuggable = true
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }

        release {
            isDebuggable = false
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.toVersion(libs.versions.javaVersion.get())
        targetCompatibility = JavaVersion.toVersion(libs.versions.javaVersion.get())
    }

    buildFeatures {
        buildConfig = true
    }

    testOptions {
        // Logger wraps android.util.Log; return default values so unit tests can run.
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    compileOnly(libs.xposed.api)

    implementation(project(":android:api"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.cio)

    testImplementation(libs.kotlin.test)
}

/** Downloads the pinned quickjs-ng release and verifies it before CMake sees it. */
abstract class FetchQuickjs @Inject constructor(
    private val fs: FileSystemOperations,
    private val archives: ArchiveOperations,
) : DefaultTask() {
    @get:Input
    abstract val version: Property<String>

    @get:Input
    abstract val sha256: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun fetch() {
        val url = "https://github.com/quickjs-ng/quickjs/archive/refs/tags/v${version.get()}.tar.gz"
        val archive = File.createTempFile("quickjs-ng-", ".tar.gz")

        try {
            logger.lifecycle("Downloading $url")
            URI(url).toURL().openStream().use { source ->
                archive.outputStream().use(source::copyTo)
            }

            val digest = MessageDigest.getInstance("SHA-256")
            archive.inputStream().use { source ->
                val buffer = ByteArray(1 shl 16)
                while (true) {
                    val read = source.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
            val found = digest.digest().joinToString("") { "%02x".format(it) }
            check(found == sha256.get()) {
                "quickjs-ng ${version.get()} downloaded with sha256 $found, expected ${sha256.get()}"
            }

            fs.sync {
                from(archives.tarTree(archive))
                into(outputDir)
            }
        } finally {
            archive.delete()
        }
    }
}

val fetchQuickjs = tasks.register<FetchQuickjs>("fetchQuickjs") {
    description = "Downloads the quickjs-ng sources the Phoenix runtime links against."
    version = libs.versions.quickjsNg
    sha256 = libs.versions.quickjsNgSha256
    outputDir = layout.projectDirectory.dir("native/third_party")
}

// AGP creates the CMake tasks lazily, so match by name instead of by type.
tasks.matching { it.name.startsWith("configureCMake") || it.name.startsWith("buildCMake") }
    .configureEach { dependsOn(fetchQuickjs) }

/** A `:bundle` output per build type. [flavor] is "" for the React Native bundle, "Phoenix" for the native client. */
fun bundleFiles(flavor: String) = listOf("debug", "release").associateWith { buildType ->
    val name = "${buildType}${flavor}Bundle"
    val scope = configurations.dependencyScope(name)
    dependencies.add(scope.name, dependencies.project(":bundle", name))
    configurations.resolvable("${name}Files") { extendsFrom(scope.get()) }
}

/** Debug builds ship the development bundle. */
val bundles = bundleFiles("")
val phoenixBundles = bundleFiles("Phoenix")

/** Copies both client bundles and the React Native manifest into the APK's assets. */
abstract class BundleAssets @Inject constructor(private val fs: FileSystemOperations) : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val bundle: ConfigurableFileCollection

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val phoenixBundle: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        fs.sync {
            // Both bundles ship a manifest.json. Only the React Native one is read on device, so
            // the Phoenix bundle comes over without its manifest to avoid the name clash.
            from(bundle) { include("valenced.bundle", "manifest.json") }
            from(phoenixBundle) { include("valenced.phoenix.bundle") }
            into(outputDir)
        }
    }
}

androidComponents {
    onVariants { variant ->
        val assets = tasks.register<BundleAssets>("${variant.name}BundleAssets") {
            bundle.from(bundles.getValue(variant.buildType!!))
            phoenixBundle.from(phoenixBundles.getValue(variant.buildType!!))
        }
        variant.sources.assets?.addGeneratedSourceDirectory(assets, BundleAssets::outputDir)
    }
}

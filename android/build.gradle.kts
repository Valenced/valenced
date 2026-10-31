import javax.inject.Inject

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(libs.versions.javaVersion.get().toInt())
}

android {
    namespace = "app.valenced.xposed"
    compileSdk = libs.versions.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "app.valenced.xposed"
        minSdk = libs.versions.minSdk.get().toInt()
        targetSdk = libs.versions.targetSdk.get().toInt()
        versionCode = 10300
        versionName = "1.3.0"
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

/** The JS bundle and its manifest from `:bundle`, per build type. Debug builds ship the development bundle. */
val bundles = listOf("debug", "release").associateWith { buildType ->
    val scope = configurations.dependencyScope("${buildType}Bundle")
    dependencies.add(scope.name, dependencies.project(":bundle", "${buildType}Bundle"))
    configurations.resolvable("${buildType}BundleFiles") { extendsFrom(scope.get()) }
}

/** Copies the bundle and its manifest into the APK's assets. */
abstract class BundleAssets @Inject constructor(private val fs: FileSystemOperations) : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val bundle: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        fs.sync {
            from(bundle) { include("valenced.bundle", "manifest.json") }
            into(outputDir)
        }
    }
}

androidComponents {
    onVariants { variant ->
        val assets = tasks.register<BundleAssets>("${variant.name}BundleAssets") {
            bundle.from(bundles.getValue(variant.buildType!!))
        }
        variant.sources.assets?.addGeneratedSourceDirectory(assets, BundleAssets::outputDir)
    }
}

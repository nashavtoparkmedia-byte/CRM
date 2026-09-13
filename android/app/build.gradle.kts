import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/**
 * Release signing is read from a keystore OUTSIDE this repository.
 *
 * Point YOKO_SHELL_KEYSTORE_PROPERTIES at a properties file holding
 * storeFile / storePassword / keyAlias / keyPassword. Nothing about the
 * keystore — path, password or alias — is committed. Without it the build
 * still produces an unsigned release artifact and the debug build keeps
 * working, so a checkout never fails for want of a secret.
 */
val keystorePropertiesPath: String? = System.getenv("YOKO_SHELL_KEYSTORE_PROPERTIES")
val keystoreProperties: Properties? = keystorePropertiesPath
    ?.let { file(it) }
    ?.takeIf { it.isFile }
    ?.let { f -> Properties().apply { f.inputStream().use { load(it) } } }

android {
    namespace = "ru.yokoone.crm.shell"
    compileSdk = 34

    defaultConfig {
        applicationId = "ru.yokoone.crm.shell"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-stage1"
        // UI Automator drives the WebView through its accessibility tree, which
        // is the only way to assert on what the operator actually sees.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // The single origin this shell is allowed to render. Compile-time
        // constant: there is no runtime setting, no intent extra and no
        // notification field that can move the shell to another origin.
        buildConfigField("String", "CRM_ORIGIN", "\"https://yokoone.ru\"")
        buildConfigField("boolean", "IS_TEST_BUILD", "false")
        buildConfigField("boolean", "CAPTURE_CONSOLE", "false")
        // Stamped so a diagnostic line names the exact source it came from.
        buildConfigField(
            "String",
            "GIT_COMMIT",
            "\"${(project.findProperty("yokoGitCommit") as String?) ?: "unknown"}\"",
        )
        // Server-side gate. The shell never builds a /messages URL itself;
        // it hands the target to this path and the CRM decides where to go.
        buildConfigField("String", "OPEN_CHAT_PATH", "\"/messages/open\"")
        buildConfigField("String", "MESSENGER_PATH", "\"/messages\"")
    }

    signingConfigs {
        if (keystoreProperties != null) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    // Instrumentation tests run against the acceptance variant, because that is
    // the build that talks to a disposable backend. Without this AGP would only
    // generate androidTest tasks for `debug`, which points nowhere useful.
    testBuildType = "acceptance"

    buildTypes {
        /**
         * Acceptance build against a disposable backend.
         *
         * Installing an APK adds no server routes: the mobile login and the
         * notification gate only exist on a backend running this branch. Until
         * a deploy carries them, acceptance needs a test backend, and this
         * variant is how the shell points at one.
         *
         * It installs alongside the production-origin build rather than over
         * it, so a tester can hold both and never confuse which backend they
         * are looking at. Origin comes from -PyokoTestOrigin at build time and
         * is still a compile-time constant in the artifact.
         */
        create("acceptance") {
            initWith(getByName("release"))
            applicationIdSuffix = ".acceptance"
            versionNameSuffix = "-acceptance"
            // Debuggable on purpose. The first diagnostic build was not, and a
            // Samsung S23 Ultra produced no application logs at all: One UI
            // drops them for a non-debuggable package. It also unlocks
            // `adb shell run-as`, which is how the diagnostic file comes off the
            // device when logcat is filtered. Test variant only.
            isDebuggable = true
            matchingFallbacks += listOf("release")

            val testOrigin = (project.findProperty("yokoTestOrigin") as String?)
                ?: "http://10.0.2.2:3002"
            buildConfigField("String", "CRM_ORIGIN", "\"$testOrigin\"")
            buildConfigField("boolean", "IS_TEST_BUILD", "true")
            // Mirror page-level JavaScript errors into logcat so a failure that
            // only happens in the device WebView can actually be read. Test
            // builds only; the production variant below leaves this false.
            buildConfigField("boolean", "CAPTURE_CONSOLE", "true")

            if (keystoreProperties != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }

        release {
            isMinifyEnabled = false
            isDebuggable = false
            buildConfigField("boolean", "CAPTURE_CONSOLE", "false")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (keystoreProperties != null) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }

    buildFeatures {
        buildConfig = true
        viewBinding = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.0")
    // androidx.webkit gives the origin-scoped WebMessageListener bridge and
    // the feature-detection helpers used instead of addJavascriptInterface.
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("com.google.android.material:material:1.12.0")

    // Robolectric runs the shell's pure navigation logic on the JVM, so origin
    // pinning and payload validation are provable without a device.
    androidTestImplementation("androidx.test:runner:1.5.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.12.2")
    testImplementation("androidx.test:core:1.5.0")
}

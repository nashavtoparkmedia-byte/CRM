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

        // The single origin this shell is allowed to render. Compile-time
        // constant: there is no runtime setting, no intent extra and no
        // notification field that can move the shell to another origin.
        buildConfigField("String", "CRM_ORIGIN", "\"https://yokoone.ru\"")
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

    buildTypes {
        release {
            isMinifyEnabled = false
            isDebuggable = false
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
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.12.2")
    testImplementation("androidx.test:core:1.5.0")
}

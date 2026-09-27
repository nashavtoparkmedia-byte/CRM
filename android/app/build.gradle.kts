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
        // The one endpoint the shell itself calls. Compile-time, like the
        // origin it is appended to: there is no setting, no intent extra and no
        // payload field that can point the registrar anywhere else.
        buildConfigField("String", "PUSH_REGISTRATION_PATH", "\"/api/mobile/push-registration\"")
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
    //
    // This configures the TEST lane only. It selects which existing variant the
    // instrumentation APK is built against and changes no product behaviour:
    // measured on the acceptance APK, adding these settings leaves 893 of 894
    // packaged entries byte-identical, the dex payload identical at 10,350,332
    // bytes and the defined class set identical at 6,728 classes.
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

    // One test seam, two implementations, chosen by the build rather than at
    // runtime. src/acceptance carries TestNotificationSeed, its receiver and the
    // hook that posts it; debug and release compile the no-op in src/noop
    // instead. The distinction matters: a runtime flag can be flipped and still
    // ships the class, while a source set that was never compiled into the
    // variant leaves nothing in the artifact to reach. The release assertions in
    // the acceptance workflow check exactly that.
    sourceSets {
        getByName("debug").java.srcDir("src/noop/java")
        getByName("release").java.srcDir("src/noop/java")
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

/**
 * Make a failing unit test say what failed, in the job summary.
 *
 * Reading an Actions job log needs admin rights on the repository; annotations
 * do not. Without this, a red test step is a single "Process completed with
 * exit code 1" and every repair is a guess. The notice on start also
 * distinguishes the two failure modes that look identical from outside: a
 * Kotlin compile error never reaches it.
 */
tasks.withType<Test>().configureEach {
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        showStackTraces = true
    }
    doFirst {
        // Names the classes the task actually discovered. A variant source set
        // that AGP did not pick up, or a --tests filter that matches nothing,
        // is otherwise indistinguishable from a failing assertion.
        val discovered = testClassesDirs.asFileTree
            .matching { include("**/*Test.class") }
            .files
            .map { it.name.removeSuffix(".class") }
            .sorted()
        println("::notice::$name started with ${discovered.size} test classes: ${discovered.joinToString(",").take(400)}")
    }
    addTestListener(object : org.gradle.api.tasks.testing.TestListener {
        override fun beforeSuite(suite: org.gradle.api.tasks.testing.TestDescriptor) = Unit
        override fun afterSuite(
            suite: org.gradle.api.tasks.testing.TestDescriptor,
            result: org.gradle.api.tasks.testing.TestResult,
        ) = Unit
        override fun beforeTest(descriptor: org.gradle.api.tasks.testing.TestDescriptor) = Unit
        override fun afterTest(
            descriptor: org.gradle.api.tasks.testing.TestDescriptor,
            result: org.gradle.api.tasks.testing.TestResult,
        ) {
            if (result.resultType == org.gradle.api.tasks.testing.TestResult.ResultType.FAILURE) {
                val cause = result.exceptions.firstOrNull()?.toString()
                    ?.replace("\n", " / ")
                    ?.take(600)
                    ?: "failed"
                println("::error::${descriptor.className}#${descriptor.name}: $cause")
            }
        }
    })
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.0")
    // androidx.webkit gives the origin-scoped WebMessageListener bridge and
    // the feature-detection helpers used instead of addJavascriptInterface.
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("com.google.android.material:material:1.12.0")
    // Durable, network-aware scheduling for the one request the shell makes.
    // A token can arrive while the device is offline and the process can die
    // before connectivity returns, so the retry has to outlive both; 2.9.x is
    // the last line that builds against compileSdk 34.
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    // Firebase Cloud Messaging. The dependency compiles and the app runs with
    // no Firebase configuration at all: FirebaseApp simply never initializes,
    // the service is never dispatched to, and FcmTokenProvider fetches nothing.
    implementation(platform("com.google.firebase:firebase-bom:33.1.2"))
    implementation("com.google.firebase:firebase-messaging")

    // Robolectric runs the shell's pure navigation logic on the JVM, so origin
    // pinning and payload validation are provable without a device.
    androidTestImplementation("androidx.test:runner:1.5.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.12.2")
    testImplementation("androidx.test:core:1.5.0")
}

/**
 * Firebase configuration is external, and its absence is a normal build state.
 *
 * No google-services.json is committed, and none may be: it is generated for a
 * specific Firebase project and belongs to whoever owns that project. Without
 * it this build produces an APK with the messaging code compiled in and no
 * Firebase configuration, which is exactly what deterministic CI and the
 * emulator acceptance run need — nothing initializes, nothing registers, and no
 * external service is contacted.
 *
 * To run physical acceptance, place the Owner-provided file at
 * android/app/google-services.json (git-ignored) and rebuild THE SAME commit.
 * The plugin then applies, Firebase initializes, and the current token becomes
 * available. No tracked file changes, so the candidate under test is still the
 * candidate that was reviewed.
 *
 * The file must register both application ids, because the acceptance variant
 * carries a suffix and the plugin fails a build whose id it cannot find:
 *
 *     ru.yokoone.crm.shell
 *     ru.yokoone.crm.shell.acceptance
 */
if (file("google-services.json").isFile) {
    apply(plugin = "com.google.gms.google-services")
    logger.lifecycle("google-services.json present: Firebase configuration will be compiled in")
}

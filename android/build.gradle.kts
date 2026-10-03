plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
    // Declared, never applied here. The app module applies it only when an
    // external google-services.json is present, so one commit serves both a
    // deterministic build with no Firebase configuration and a physical run
    // with one.
    id("com.google.gms.google-services") version "4.4.2" apply false
}

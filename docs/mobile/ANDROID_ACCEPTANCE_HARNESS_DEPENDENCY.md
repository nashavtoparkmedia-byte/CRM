# What this harness needs before it can run

This branch carries the reusable Android acceptance infrastructure only. It does
**not** carry the Android shell, which arrives with PR #87 — `main` has no
`android/` directory at all today.

So this must merge **after** PR #87, and one small piece of configuration has to
travel with the Android module rather than with this branch, because the file it
edits does not exist here.

## The missing three settings

`android/app/build.gradle.kts` needs, inside `android { defaultConfig { … } }`:

```kotlin
testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
```

inside `android { … }`:

```kotlin
// Instrumentation tests run against the acceptance variant, because that is
// the build that talks to a disposable backend. Without this AGP would only
// generate androidTest tasks for `debug`, which points nowhere useful.
testBuildType = "acceptance"
```

and in `dependencies { … }`:

```kotlin
androidTestImplementation("androidx.test:runner:1.5.2")
androidTestImplementation("androidx.test.ext:junit:1.1.5")
androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
```

Without them `:app:assembleAcceptanceAndroidTest` does not exist and the
workflow's install step fails.

## Why that configuration is safe to add

It configures the separate instrumentation APK and leaves the acceptance APK
alone. That is measured rather than assumed: building the shell candidate and
the harness-configured tree with the same signing key, commit stamp and origin
gives 893 of 894 packaged entries byte-identical, an identical total dex payload
of 10,350,332 bytes, and an identical defined class set of 6,728 classes. The one
differing entry, `classes3.dex`, also differs between two builds of the *same*
tree, because multidex class assignment is not deterministic — which is also why
APK SHA-256 is not a usable equivalence test here.

## What is deliberately NOT here

No product change from PR #87, and no signing change. Earlier versions of this
harness patched `android/app/build.gradle.kts` to fall back to the debug
keystore when no release keystore was present. That made the test tree differ
from the product tree, so it was replaced: the workflow generates a throwaway
keystore per run and points the build's existing
`YOKO_SHELL_KEYSTORE_PROPERTIES` at it. No Android source has to change to
produce an installable APK.

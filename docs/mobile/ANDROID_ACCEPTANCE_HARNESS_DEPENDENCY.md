# Instrumentation configuration and signing, and why they look the way they do

`main` carries `android/` now, so the dependency this document originally
described is resolved. The instrumentation settings it said had to travel
separately are present in `android/app/build.gradle.kts` on this branch.

## The instrumentation settings

Three things, all of which configure the test lane and none of which changes
product runtime:

```kotlin
// android { defaultConfig { … } }
testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

// android { … }
testBuildType = "acceptance"

// dependencies { … }
androidTestImplementation("androidx.test:runner:1.5.2")
androidTestImplementation("androidx.test.ext:junit:1.1.5")
androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
```

`testBuildType` selects which existing variant the instrumentation APK is built
against — the acceptance one, because that is the build that talks to a
disposable backend. Without it AGP only generates androidTest tasks for `debug`,
which points nowhere useful. The other four exist only inside the
instrumentation APK.

## Why that is safe, measured rather than asserted

Building the shell candidate and the harness-configured tree with the same
signing key, commit stamp and origin:

- 893 of 894 packaged entries byte-identical
- total dex payload identical at 10,350,332 bytes
- defined class set identical at 6,728 classes

The one differing entry is `classes3.dex`, and it differs between two builds of
the *same* tree as well, because multidex class assignment is not deterministic.

## Why an APK SHA-256 is not an equivalence proof

Because of exactly that. The build is not byte-reproducible: the same sources
twice give different APK digests, so a digest comparison reports a difference
where there is none, and would equally hide a real one behind an expected
mismatch. Compare the defined class set instead —
`apkanalyzer dex packages --defined-only` — together with the packaged entry
list and the dex payload size.

For deciding whether an already-installed APK is still valid, compare the
tracked Android build inputs at the two commits rather than the artifacts:
every file under `android/` except `android/app/src/androidTest/`, which
compiles into a separate APK and cannot reach the app under test.

## Signing stays CI-only

No Android source has a debug-keystore fallback, and none should. An earlier
version of this harness added one, which made the test tree differ from the
product tree in a product file. Instead the workflow generates a throwaway
keystore with `keytool` and points the build's existing
`YOKO_SHELL_KEYSTORE_PROPERTIES` at it. The key lives for the length of one job,
is never committed, and signs nothing that leaves the runner. Both the app APK
and the instrumentation APK are signed with it, which `am instrument` requires.

One consequence worth knowing: an acceptance APK built where the real release
keystore exists and one built in CI carry different signatures, so neither
installs over the other. Uninstall first when switching between them.

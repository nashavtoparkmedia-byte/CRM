# YOKO CRM Android shell — Stage 1

A thin Android wrapper around the deployed CRM Messenger at `https://yokoone.ru`.
It ships no CRM code and renders no screens of its own except a login prompt it
never shows (the CRM does) and a network-error panel.

## Why a Kotlin WebView and not Capacitor

Capacitor's production model bundles static web assets into the APK and serves
them from `capacitor://localhost`. The CRM cannot be bundled that way: the root
layout declares `export const dynamic = 'force-dynamic'`, 39 source files carry
`'use server'`, and pages read cookies during server rendering. Nothing in the
repository can produce a static export.

The remaining Capacitor option is `server.url`, which points the WebView at a
remote origin. That option is documented for live reload during development. It
also puts the app on a different origin than the one the cookies belong to and
adds a generated `android/` Gradle project plus a node dependency tree to a
repository whose architecture controls scan the whole tree.

A plain `androidx` WebView shell is ten source files, has no npm surface, and
gives direct control over the four things that actually matter here: cookie
persistence across process death, origin pinning, an origin-scoped JS bridge,
and keyboard/inset behaviour.

## Build

Requires a JDK 17 and an Android SDK with platform 34 and build-tools 34.

```
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_SDK_ROOT=/opt/android-sdk
bash tools/bootstrap-gradle.sh :app:assembleRelease
```

`tools/bootstrap-gradle.sh` downloads the Gradle distribution pinned in
`gradle/wrapper/gradle-wrapper.properties` and refuses to run if its SHA-256
does not match. The wrapper JAR is deliberately not committed.

Unit tests (JVM, no device or emulator needed):

```
bash tools/bootstrap-gradle.sh :app:testReleaseUnitTest
```

## Signing

Release signing reads a properties file whose path comes from
`YOKO_SHELL_KEYSTORE_PROPERTIES`. Nothing about the keystore is committed. Keep
the same keystore for every test build so a new APK installs over the previous
one instead of asking the tester to uninstall first.

```
storeFile=/absolute/path/to/keystore.jks
storePassword=...
keyAlias=yoko-shell
keyPassword=...
```

Without that variable the build still succeeds and produces an unsigned
release artifact.

## What the shell guarantees

| Property | Where it is decided |
|---|---|
| One origin, compile-time constant | `BuildConfig.CRM_ORIGIN`, enforced by `CrmOrigin.isInAppUrl` |
| A notification payload can never become a URL | `CrmOrigin.buildOpenChatUrl` validates, then targets the CRM gate |
| A notification target is acted on once, not replayed | `consumeDeepLinkUrl` strips the extras from the Intent |
| No cleartext, no click-through on a bad certificate | `network_security_config.xml`, `onReceivedSslError` cancels |
| No JavaScript bridge at all | Nothing is injected into the page; see the Bridge note in `MainActivity` |
| The shell never becomes a second softphone | `onPermissionRequest` denies; the CRM also withholds SIP credentials from a mobile session |
| A notification never marks a message read | The shell issues no network request of its own |

The URL and payload rules are covered by 16 JVM tests in
`app/src/test/java/ru/yokoone/crm/shell/`. The rest are structural: there is no
bridge to test, and the shell has no HTTP client to make a request with.

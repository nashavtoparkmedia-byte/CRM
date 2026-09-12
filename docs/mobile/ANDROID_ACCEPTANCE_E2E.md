# Android acceptance E2E

Automated replacement for the manual phone loop that has been consuming the
product owner's time on APK debugging.

## What it does

On a GitHub-hosted Linux runner, for every push to
`codex/android-acceptance-e2e-**`:

1. Brings up a disposable PostgreSQL service and applies the committed
   migrations to it.
2. Seeds the same synthetic conversations the manual runbook uses,
   `android/tools/acceptance-seed.sql`.
3. Builds and starts the CRM with `env -i` and an explicit allowlist, so no
   Telegram, WhatsApp, MAX, Avito, bot, SIP or TURN credential exists in the
   process. Every outbound transport is inert by construction.
4. Asserts the shell lane already fails closed before a single test runs.
5. Builds the acceptance APK pointed at `http://10.0.2.2:3002`, the host alias
   inside Android's user-mode network stack, plus the instrumentation APK.
6. Boots a hardware-accelerated `android-34` emulator and runs UI Automator
   tests against it.
7. Collects logcat, the shell's own diagnostics file, screenshots, the JUnit
   report and the APK digest as artifacts.

## Why UI Automator

Everything the operator sees is inside a WebView. Espresso sees one opaque view;
UI Automator reads the accessibility tree the WebView publishes, which is what a
screen reader would see. The assertions are therefore about text a person can
actually read on screen, not about implementation details.

## Why it is expected to be red right now

`test02_correctPasswordAfterRejectionOpensTheMessenger` asserts that the
messenger opens after a correct password following a rejection. That is the
defect under investigation in PR #87, where the device shows a client-side
exception instead.

The test is written to describe the promised behaviour, not the current one. It
stays red until the defect is fixed. A suite that goes green while the product
is broken is worse than no suite, and encoding the crash as acceptable would
throw away the only automated signal that it is still there.

## What fails the run

- Any uncaught JavaScript error, detected from the shell's `YOKO_PAGE_ERROR`
  diagnostics.
- Any Android crash in the shell package.
- The shell's diagnostics never reporting at all, because then the run proves
  nothing either way. This is the lesson from the first manual attempt, where an
  empty log was mistaken for an absence of errors.
- The CRM not becoming reachable, or the shell lane not already failing closed.

## Relationship to the authoritative workflow

None. This does not modify, wrap or substitute for
`.github/workflows/architecture-enforcement.yml`, and it is not part of the
authoritative control catalogue. It proves one thing that suite cannot: that the
shell behaves correctly on a real Android system.

## Cost

The repository is public, so GitHub-hosted standard Linux runners are free and
the run consumes no billable minutes. If the repository ever becomes private,
this job would bill at the standard Linux rate for its wall-clock time, which is
dominated by emulator boot and the CRM build.

## What it still does not prove

Behaviour on physical Samsung hardware. An `x86_64` emulator running Google APIs
is not a Samsung S23 Ultra with One UI: WebView build, log delivery and
accessibility behaviour all differ, and the current defect is precisely one that
did not reproduce off-device. This suite catches regressions early and cheaply;
it does not replace the final check on the real handset.

## Firebase Test Lab

Not connected. It would need a Google Cloud project, a billing profile and
service-account credentials held as repository secrets, none of which exist and
none of which should be created as a side effect of this work. See the stage
notes in the pull request for what a later step would require.

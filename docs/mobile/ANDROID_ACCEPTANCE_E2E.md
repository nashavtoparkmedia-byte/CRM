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

## Run #1: what it proved and what it did not

Run #1 on `55b5bb9d` was cancelled, not failed. Every step up to and including
the APK builds passed: the disposable database came up, migrations applied, the
seed loaded, the CRM built and started, the shell lane was confirmed to fail
closed, and both the acceptance APK and the instrumentation APK built.

It then stalled in `Start an emulator`. Both waits in that step were unbounded,
so when the emulator did not report a completed boot the step simply sat there
until the job's 60-minute timeout cancelled the whole run. A cancelled run skips
the collection step, so the emulator log that would have explained the stall was
never kept — the run cost an hour and produced no evidence.

Every wait in that step is now bounded and every failure path prints the
emulator log and the device list before exiting. A boot problem now costs
minutes and leaves something to read.

Run #2, with those bounds in place, died one step earlier and for a different
reason: `test -w /dev/kvm` returned false, so the KVM step's own exit status
killed the run. Hardware acceleration is **not guaranteed** on a standard
GitHub-hosted runner — run #1 got a writable `/dev/kvm`, run #2 did not. That
probe no longer decides the run's fate; it records what it found, warns, and
hands the acceleration mode to the emulator step.

This is the open risk in the approach: without KVM the emulator falls back to
software emulation on a two-core runner, which may not finish booting inside
any sensible budget. If that turns out to be the steady state, the realistic
options are a larger runner, a third-party emulator action, or accepting that
this suite runs only when a runner happens to offer KVM. None of them should
be chosen without seeing a software-emulation run actually time out first.

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

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

## Why it was written red, and why it should now be green

`test02_correctPasswordAfterRejectionOpensTheMessenger` asserts that the
messenger opens after a correct password following a rejection. When it was
written, the device showed a client-side exception instead, so the test was red
on purpose: it described the promised behaviour rather than the current one,
because a suite that goes green while the product is broken is worse than no
suite.

That defect is fixed, and separately so is the `POST /messages` 500 that a
refused AI-intern read used to produce on every messenger page load. No
assertion was loosened to accommodate either. The test is therefore expected to
pass now, and a red result means a real regression rather than a known gap.

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

Run #2, with those bounds in place, died one step earlier: `test -w /dev/kvm`
was the KVM step's own exit status, so a runner without hardware acceleration
failed the run with no explanation. Run #3 stalled in the emulator step again,
and its `::error::` annotation did not survive the cancellation, so the reason
was never recoverable.

Run #4 is the first run that finished rather than being cancelled, and it
settled the question that three runs could not:

```
[notice] runner /dev/kvm: crw-rw-rw- 1 root kvm 10, 232 Sep 12 23:53 /dev/kvm
```

Hardware acceleration **is** available on a pinned `ubuntu-24.04` runner once
GitHub's own udev rule is applied. "No KVM on the runner" is ruled out. The
collection and upload steps also ran for the first time, which is what made any
of this readable.

Run #4 still failed, in the third-party emulator action, with
`The process '/usr/bin/sh' failed with exit code 1` and nothing else — because
that action's diagnostics live in the step log, and a step log needs an
authenticated download. So the emulator is driven directly again, and its log
is republished as annotations, which are public on a public repository.

## Run #5: the actual cause, from the emulator's own log

Run #5 published it as an annotation, which is what all the plumbing above was
for:

```
ERROR | Unknown AVD name [ci], use -list-avds to see valid list.
ERROR | HOME is defined but there is no file ci.ini in $HOME/.android/avd
```

The AVD was never created. The step that creates it reported **success**,
because `avdmanager create avd` prints `Error: Package path is not valid` on
stdout and still exits 0, so `set -e` had nothing to catch. The emulator then
started, found no AVD named `ci`, and exited immediately — which is why the
device never appeared, in this run and almost certainly in the earlier ones.

It is not a KVM problem, not a runner problem, not a boot timeout and not
software emulation. It is a configuration step that failed silently.

The remedy is to stop trusting exit codes for this tool. Each stage is now
verified by its observable result: the system image directory has to exist
after `sdkmanager`, `ci.ini` has to exist after `avdmanager`, and
`emulator -list-avds` has to list `ci` before the emulator is started. Each
check prints the relevant tool output as annotations when it fails.

## Run #6: the emulator boots

With the AVD actually verified, the device came up:

```
INFO | Boot completed in 42081 ms
adb devices: emulator-5554  device  product:sdk_gphone64_x86_64
```

Forty-two seconds with hardware acceleration, which also settles the boot
budget question: the 15-minute ceiling is roughly twenty times what is needed.

The failure moved one step later, into the instrumentation run itself, so the
same treatment is applied to it: Gradle's output is captured to a file, and its
salient lines plus every JUnit failure message are republished as annotations.

## Why the runner is pinned

`ubuntu-latest` is a moving label and is how this job became a lottery: one run
found a writable `/dev/kvm` and the next did not. The label is pinned to
`ubuntu-24.04`, the udev rule is the **first** step in the job because a
mid-job systemd upgrade resets `/dev` permissions after the rule is applied
(actions/runner-images#8670), and acceleration is then asserted twice: once on
the device node and once through `emulator -accel-check`. A run either has
hardware acceleration or fails in seconds saying so. It never quietly drops to
software emulation, which reads as a slow boot and reports as a timeout.

Software emulation is not a fallback worth having here: measured cold boots of
an API 34 x86_64 image without KVM run to roughly 38 minutes when they finish
at all.

## Why no third-party emulator action

`reactivecircus/android-emulator-runner` is the maintained community path and
was tried in run #4. Two things rule it out for this job: its failure output is
only in the step log, which cannot be read without a token, and its default
`disable-linux-hw-accel: auto` silently appends `-accel off` when `/dev/kvm` is
not accessible, which is the exact ambiguity this suite exists to remove. The
hand-rolled path writes a log this job owns and asserts acceleration up front.

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

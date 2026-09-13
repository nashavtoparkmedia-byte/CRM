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

## Run #7: the APK was unsigned

The emulator booted again and the instrumentation run named its own cause:

```
com.android.ddmlib.InstallException: INSTALL_PARSE_FAILED_NO_CERTIFICATES:
Failed to collect certificates from .../app-acceptance-unsigned.apk
```

The `acceptance` build type was signed only when a release keystore was present
on the build machine. A CI runner has none, so Gradle produced
`app-acceptance-unsigned.apk`, and Android refuses to install an unsigned APK.
This never showed up on the physical phone because the server that built that
APK does have the keystore.

The variant now falls back to the standard Android debug keystore when no
release keystore exists. `release` deliberately keeps no such fallback: a
release build without the real keystore must stay unsigned rather than quietly
ship debug-signed. One consequence to know: an acceptance APK built on the
server and one built in CI carry different signatures, so neither installs over
the other.

## Run #8: real Android instrumentation, and a real test failure

The APK installed, `LoginAcceptanceTest` executed on `emulator-5554`, and the
shell's own `YOKO_NATIVE_OK` marker appeared, so the crash-and-JavaScript gate
passed for the first time. This is the first run that produced an Android test
result rather than an infrastructure failure.

Four tests failed, all with the same assertion:

```
Tests on emulator-5554 - 14 failed: There was 4 failure(s).
java.lang.AssertionError: app did not reach the sign-in screen
```

The shell starts and reports natively, but the sign-in screen does not appear
within the test's window. That is a genuine acceptance finding, not a CI defect,
and it is what the suite exists to catch.

The annotation budget is now spent deliberately — GitHub caps them at ten per
level per step, and the shell's diagnostics were being crowded out by emulator
noise. The shell's own `YOKO_NET` / `YOKO_JS_OK` lines and the CRM's request log
come first, because together they separate "the device never reached the CRM"
from "it did and the UI did not appear".

## Run #12: the cause of the failing assertion

The probe launched the shell, left it in the foreground, and dumped the
accessibility tree while it was there:

```
probe: 13 nodes, WebView=0, sign-in text=0, pkg-in-tree=0
probe text: text="Allow YOKO CRM to send you notifications?"
probe text: text="Allow"   text="Don't allow"
```

Android 13 asks for `POST_NOTIFICATIONS` the first time the shell runs, and
that dialog sits in front of everything. The WebView is behind it. Every test
failed with "app did not reach the sign-in screen" while the shell's own log
showed it loading the login page in under 100 ms, because UI Automator was
looking at a system dialog.

It never surfaced on the physical handset because a person dismissed it once
without it registering as a finding.

The suite now grants that permission before launching the app. This is not a
weakening: what is being accepted is the sign-in and messenger flow, an
operator grants this once on a real device and never sees it again, and leaving
it to chance would mean measuring the timing of an OS dialog rather than the
product.

## Run #14: the WebView does publish its content

Dumping the tree a second time, after a pause, answered the question the first
dump could not:

```
probe: 63 nodes, WebView=1, sign-in text=1, pkg-in-tree=1
probe text: text="Войти"   text="YOKO CRM"
```

The WebView publishes its content to the accessibility tree, including the
sign-in text the assertions look for. The earlier `7 nodes, sign-in text=0` was
an artifact of the probe itself: `uiautomator dump` is what attaches an
accessibility client, and a WebView does not backfill a tree it rendered before
one existed. Given a client and a moment, everything is there.

So the suite's reading mechanism is sound and needs no redesign. What is still
unexplained is why the instrumentation run fails, and that is readable only
from Gradle's output.

## Run #16: the suite reaches the product

`app did not reach the sign-in screen` is gone. All four tests now get past
launch and fail on the flow itself:

```
Tests on emulator-5554 - 14 failed: There was 4 failure(s).
  no readable rejection message after a wrong password
  the messenger did not open after a correct password following a rejection
  the messenger did not open on a direct correct login
  the conversation list never appeared
```

These are the assertions the stage promises, failing about the product rather
than about the harness. The sign-in form is reached and submitted; what comes
back is not.

The probe in the same run showed the shell's own offline screen — `Нет связи с
CRM` with a `Повторить` button — which is a race in the probe rather than a
finding: it launches the app immediately after boot, before `10.0.2.2` is
routable. It now waits for the CRM to answer from inside the emulator first.

The CRM's own log is no use here, because Next.js does not log requests and the
disposable stand has no request-logging proxy in front of it. The shell's
`YOKO_NET` lines are the only record of method, path and status on this side,
so the published ones are now filtered to the sign-in POST and to failures.

## Run #17, and a reading that does not hold

Run #17 published the sign-in requests:

```
YOKO_NET done POST /login/mobile status=200 47ms
YOKO_NET done POST /login/mobile status=200 68ms
YOKO_NET done POST /login/mobile status=200 23ms
YOKO_NET done POST /login/mobile status=200 79ms
```

On the local stand a rejected sign-in is 200 and a successful one is 303, so
four 200s look like four rejections. **That inference is wrong here.** Those
local numbers come from a request-logging proxy watching raw HTTP; the shell's
`YOKO_NET` line comes from `fetch`, which follows redirects, so a 303 to
`/messages` is reported as the final 200. The status alone cannot tell a
rejection from a success on this side.

What is real is that `test01` fails on the rejection path too: a wrong password
produces no readable "Неверный логин или пароль". Both that and the messenger
never opening are consistent with a single mechanism — the accessibility tree
is built when the page first renders, and a client-side update may not be
published to it. The text can be on screen and invisible to the assertion.

Distinguishing those needs a dump taken while the screen under test is still
up, which no dump so far has been. `LoginAcceptanceTest` now carries a
`TestWatcher` that writes a screenshot and the hierarchy at the moment an
assertion fails, and the workflow reports what each of those hierarchies
contains.

## Run #20: the suite was clicking the wrong button

Carrying the evidence in the failure message itself produced the answer that
six runs of file-based capture could not. All four assertions reported the same
screen:

```
Главная / Открыть меню / Войти... / Новые лиды / — / YOKO CRM /
Вход в мобильное приложение / Сотрудник / Логин / acceptance / Пароль /
•••••••••••••••••••••••••• / Войти / Вход · YOKO CRM
```

Read it carefully. The form is still there, the login field holds `acceptance`,
the password field holds the right number of characters — 26 for the correct
password, 27 for the wrong one, so the typing works. There is no error message,
no navigation, and the button reads `Войти` rather than `Вход…`, so nothing was
ever in flight.

And two elements match `Войти`: the CRM chrome's own `Войти...`, listed first,
and the form's button. `signIn` selected the submit button with
`By.textContains("Войти")`, which matches both, and `findObject` returns
whichever comes first. The suite was clicking a navigation item and then
waiting for a login that had never been submitted.

That is a defect in the suite, not in the product. The selector is now exact
text, and `signIn` reports whether the button entered its pending state after
the click, which is the cheap proof that the click landed on the form.

## Run #21: the form submits, and the browser refuses it

With the submit button selected by exact text, the form is genuinely submitted
and the next layer appears in the failure screens:

```
Please select an item in the list. / Главная / ... / Сотрудник / Логин /
acceptance / Пароль / •••••••••••••••••••••••••• / Войти
```

That is the browser's own validation message for a `required` select with no
value. The operator was never chosen, so the page refuses to submit and nothing
reaches the server.

`signIn` looked for the select by its placeholder text and, when it did not
find it, skipped the whole step inside an `if (picker != null)`. A silent skip
of a mandatory step is the same class of mistake as a tool that exits 0 without
doing anything, and it hid this for as long as the button selector hid the
previous layer. The select is now located by several selectors in turn, and
failing to find it is an assertion that says so.

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

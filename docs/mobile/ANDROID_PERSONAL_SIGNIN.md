# Android shell: personal mobile sign-in

Owner decision D4 option 1 (2026-11-11): at mobile sign-in, an employee uses
their **own** Staff Session password, the same one as the CRM browser login.
The shared `MOBILE_ACCESS_USER` / `MOBILE_ACCESS_PASS` route and the free
choice of operator are removed. The server side, the contract and the design
note belong to identity_access: `docs/design/mobile-personal-signin-v1.md`,
PR #235.

## Release notes (for the build that ships after #235)

- **Every phone signs in again.** Sessions issued with the shared password end
  when the server change is deployed. The next screen is the sign-in form.
- **Pick yourself, type your own password.** The form has the employee list
  and one password field. The shared «Логин» field is gone. Your password is
  the one the Администратор set for you on `/users`.
- **One refusal text.** A wrong password, a disabled employee or too many
  attempts all show «Неверный пароль или вход временно ограничен». The app
  never retries on its own.
- **No saved passwords.** Password managers and autofill do not offer to keep
  the password inside the app (Security ruling, below). Sessions last 12 hours,
  so you type it at least once every 12 hours.
- **Notifications resume after the new sign-in.** A phone that was registered
  for notifications under the shared password registers again by itself once
  the employee has signed in.
- **Logging out elsewhere logs the phone out.** A browser logout, a password
  reset, a disable or a revoke ends the phone's session on its next request,
  even if the phone was offline at the time. «Выйти» on the phone ends only
  that phone's session.

## What changed in the shell

The sign-in form is the CRM page `/login/mobile` inside the WebView, so the
shell has no native credential path: it never reads, keeps, logs or retries the
password. The path, INV-21, the operator fence and «Сменить сотрудника» are
unchanged. Answers to a sign-in stay in the page (200 with the form's text), so
the shell sees no new status or redirect. The shell already treats the server's
new `503 MOBILE_SESSION_UNVERIFIABLE` on push registration as retryable, like
every 5xx.

**Autofill off (Security ruling (a), 2026-11-11).** The shell's one WebView is
`importantForAutofill="noExcludeDescendants"` in `activity_main.xml`, the
layout every build type inflates.
- Reason: personal attribution. On a shared work phone, a password saved by a
  password manager, often synced to a shared account, would let the next person
  sign in as that employee. Sessions are long-lived and the shell has no other
  form that needs autofill.
- `WebSettings.setSaveFormData(false)` is not added: it does nothing from
  API 26, and the app's `minSdk` is 26.
- It may be revisited (Security option (c)) only if the Owner confirms
  personal, single-user devices.

## Tests

- **JVM** (`ShellAutofillPolicyTest`, Robolectric, release unit tests): the
  WebView inflated from the shell's layout is `IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS`.
  The mutant without the attribute fails (`expected:<8> but was:<1>`).
- **Emulator** (`LoginAcceptanceTest`, `PushAcceptanceTest`):
  - sign-in picks Мария (u1) and types her own password into the form's one
    text field; a second text field fails the test;
  - before the password is typed, the running shell's WebView is asserted to
    be excluded from autofill;
  - a wrong password shows the one refusal text and leaves the form usable.
- **Workflow** (`android-acceptance-e2e.yml`):
  - `MOBILE_ACCESS_*` is gone. Both CRM starts get the staff lane:
    `STAFF_SESSION_SECRET`, `YOKO_USER_REGISTRY_FILE`,
    `YOKO_USER_REGISTRY_SEED=once`; the first also gets `ADMIN_USER` /
    `ADMIN_PASS` for the bootstrap;
  - after the first start, identity_access's
    `gravity-mvp/scripts/e2e-seed-staff-password.mjs` gives u1 her password
    through the product's own bootstrap over loopback HTTP;
  - every value is a synthetic, public test value that lives for one job.
    No test writes the password to diagnostics, and the helpers that build
    failure messages from the screen never report a text field's content.

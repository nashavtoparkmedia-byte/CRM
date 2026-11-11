# Personal mobile sign-in (v1)

- **Owner:** identity_access.
- **Status:** draft for Security review (2026-11-11).
- **Owner decision:** D4 option 1 (2026-11-11, ~11:30), «персональные мобильные учётные данные». At mobile sign-in, the employee uses their own Staff Session password. The shared `MOBILE_ACCESS_PASS` plus a free choice of operator is **removed** as a sign-in route. Required before production activation.
- **Builds on:** Staff Session v1.3 (`docs/design/staff-session-v1.md`), F-1 (#216), enforcement deny-by-default (`docs/design/staff-session-enforce-deny-v1.md`).

## 1. Today

`/login/mobile` (Android shell, Stage 1) asks for:
- an operator picked from the list;
- the shared `MOBILE_ACCESS_USER` / `MOBILE_ACCESS_PASS`.

The operator is the picker's choice, so whoever holds the shared password can open a session as any employee. That session is valid in both lanes (BR-4). The mobile session token is HMAC-signed with a key derived from `MOBILE_ACCESS_PASS`.

## 2. Decision

**Who signs in.** The employee picks themself and types **their own** Staff Session password. The server checks it with **the same verifier, throttle and refusal** as the browser `/login`. The operator **is the employee whose password verified**. The choice alone never decides anything.

**What is removed.** The shared route goes in this change: no flag, no parallel run, no fallback. When the staff lane is not ready, the answer is "unavailable".

### 2.1 Sign-in flow (unchanged path, no second step)

- **Page:** `/login/mobile`, the same path, rendered in the WebView.
  - The picker shows the R1 projection: active employees, `{ id, firstName, lastName, role }`.
  - Fields: `operatorId` (the chosen employee's id, which is the id the password is checked against), `password`, `deviceId`, `next`.
  - The `username` field is removed.
- **Action:** `submitMobileLoginAction(prev, formData)` calls `establishMobileSessionV1(userId, password, deviceId)`. The username parameter is gone.
- **Order of checks:**
  1. **Staff lane ready** (`staffLaneStateV1() === 'ready'`, which also makes the mobile signing key derivable, §2.2). Otherwise `unavailable`.
  2. **Device id:** a safe id, never `ephemeral-device`. Otherwise `invalid_device`. Unchanged.
  3. **No live mobile session already** (`session_active`). Unchanged (BR-4: switching operator requires a logout first).
  4. **Credential.** A shared core `verifyStaffCredentialV1({ userId, password, source })` is extracted from `staffLoginV1` and used by both lanes:
     - the same registry plus StaffCredential eligibility (Активен, `createdAt` matches, not revoked);
     - the same scrypt slot (`busy`);
     - the same throttle keys `user:<id>` and `source:<x-real-ip>`. They are **shared across lanes**, so failures on the phone throttle the browser too;
     - one uniform `refused` for every credential failure: unknown id, wrong password, disabled, no credential.
  5. **Issue a v2 mobile token (§2.2)** for `op = record.id`, bound to `row.sessionEpoch`.
  6. **Audit (O1, accepted):** a `StaffCredentialEvent` with kind `login` (already allowed by the kind check), actor `mobile:<userId>`, `sid` = the mobile session's labelled id. No migration.
     - Refusals and throttles are recorded exactly as for the browser login: a warning line without the user's input, and the throttle counter.
     - A mobile logout records kind `logout` with actor `mobile:<userId>`.
     - The table has no lane field. The `mobile:` actor prefix is the lane, and no reader treats it as a browser login: `staff:` is the browser actor. A test pins both prefixes.
- **Answers stay in-page** (200 with the form error). There are no new HTTP statuses and no `/api` call for sign-in.
  - **Refusal:** `refused` and `throttled` show one generic text («Неверный пароль или вход временно ограничен»), with no auto-retry (Security's app-side ruling).
  - **Unavailable:** `busy` and `unavailable` show «Вход временно недоступен».
  - **Success:** `redirect(next)` as today.
- **Password handling:** no password, and no password field, in any log line, error or URL. The form posts it in the action body only, and the refusal text never echoes input. Same-origin rules as the shell lane.

### 2.2 Mobile session token v2

- **Signing key:** derived from `STAFF_SESSION_SECRET` with its own label. The staff key and the mobile key are distinct, so a staff token never verifies as a mobile one or the other way round. `MOBILE_ACCESS_USER` / `MOBILE_ACCESS_PASS` are no longer read.
- **Payload:** `{ v: 2, aud: 'yoko-mobile-session', op: <employee id>, uep: <StaffCredential.sessionEpoch at issue>, did, rev: MOBILE_SESSION_REVOCATION_EPOCH, iat, exp: iat + 12 h, sid }`.
- **Migration:** a v1 token fails the version check. Every existing mobile session therefore ends when this change is deployed, and the next shell request takes the ordinary expired-session path (303 to `/login/mobile`).
  - Push registrations stay bound to their device. A new sign-in binds them to the new session, as an ordinary re-login does today.

### 2.3 Every request: the session follows the employee

The BR-4 resolver's mobile path becomes:
1. signature, version, audience, expiry and global epoch;
2. the logout barrier (unchanged);
3. **new:** the employee's staff liveness, with the **same eligibility rule as Staff Session**:
   - the registry record exists, is Активен and `createdAt` matches the row;
   - the StaffCredential row is not revoked;
   - `row.sessionEpoch === uep`.

Store or registry unreadable gives `unverifiable`, which the shell lane answers with 503, exactly as an unreadable barrier does today.

Consequences, each on the next request:

| Event | Effect on the employee's mobile session |
|---|---|
| Disabled, or re-created (`createdAt`) | ends |
| Password set or reset (`upsertVerifier` bumps the epoch) | ends |
| `endStaffSessions` (revoke) or epoch bump | ends |
| **Browser** logout (`staffLogoutV1` bumps the epoch) | ends |
| **Mobile** logout («Выйти», F-1) | ends **that** mobile session only (barrier); the desktop session stays (O2, accepted). "Log out everywhere" is a password reset or a revoke, which bump the epoch |
| Role change | the session stays; the role is read live from the registry on every request, as for Staff Session, so no stale elevated role survives (O3, accepted) |

A phone that is offline when the employee is disabled, reset or logged out in
the browser loses its session on its **next** request. The check runs per
request; it does not depend on a push or on the phone being online.

Unchanged:
- **BR-4:** a mobile cookie together with a staff cookie means no principal.
- **D2:** a mobile principal never becomes a `staff_session` principal. `getStaffSessionPrincipalV1` stays null for a mobile cookie and for the shell lane. Whether mobile employees get «Люди» is a separate Owner decision.
- **Admin-only role checks** stay where they are.

### 2.4 Push follows the employee too

Push v1 binds a registration to the shared credential:
`currentMobilePushCredentialFactsV1()` returns `{ credentialSubject: MOBILE_ACCESS_USER }`.
Fan-out and send-time eligibility require `registration.credentialSubject === facts.credentialSubject`.
With `MOBILE_ACCESS_*` gone, v2 replaces this:

- **Stored subject.** At registration the subject is written from the verified v2 session as `staff-v2:<uep>`, the employee's credential epoch carried by the token. No migration: the column exists, and the operator id is already stored on the row.
- **Eligibility.** Fan-out (`listEligible`) and send time (`sendableToken` / `resolveTarget`) keep the global filters: revoked, session expiry, global epoch, and a subject with the `staff-v2:` prefix. They add **the employee's liveness, per registration**, with the same rule as §2.3:
  - the registry record is Активен and `createdAt` matches;
  - the StaffCredential row is not revoked;
  - `row.sessionEpoch` equals the `<uep>` stored in the subject.

  A disabled, re-created, reset, revoked or browser-logged-out employee's phone stops receiving chat notifications and call alerts **at the next fan-out or send**. It does not wait for the phone's next request or the 12 h expiry. An unreadable store skips the delivery (fail closed, reason `unverifiable`); it never sends.
- **Existing registrations** stored with the shared subject fail the prefix and are skipped from deploy on. A phone re-registers automatically after it signs in again.
- **Push-registration answers in v2** (the route's status map):
  - the barrier, or the employee's liveness ended → **401 `MOBILE_SESSION_REVOKED`**. That keeps today's code for the barrier (acceptance test16), and a liveness end answers the same;
  - the session or staff store is unreadable → **503 `MOBILE_SESSION_UNVERIFIABLE`**, a new code with `Retry-After: 5`. It is retryable and never a refusal;
  - no cookie or an invalid one → 401 `MOBILE_SESSION_REQUIRED` (unchanged).

  Any refusal blocks registration until a new sign-in, as today.

### 2.5 What is removed

- **Code:** `verifyMobileAccessCredentials`, the `MOBILE_ACCESS_*` configuration, the username field, and the "configure MOBILE_ACCESS_*" text. `isMobileLaneConfigured` becomes "the staff lane is ready".
- **Docs:** the `MOBILE_ACCESS_*` rows in `docs/SECRETS.md` are retired. Removing the values from the deploy environment is an ops step (Owner).
- **Not affected:** the edge Basic auth (nginx).

## 3. Android (answers to the shell's questions)

1. **Path.** The sign-in stays `/login/mobile` in the WebView, with no new path and no second step. INV-21 is unchanged.
2. **Answers.** Refused, throttled and unavailable stay in-page: 200 with the form text. There is no fetch to `/api` and no new 401/403/429 for sign-in.
3. **Picker.** It stays: reading (a), the operator is the employee whose password verified. The operator fence (identity from `crm_user_id` at the first valid page) and «Сменить сотрудника» work unchanged.
4. **E2E seed.** IA provides `gravity-mvp/scripts/e2e-seed-staff-password.mjs`. Against a running **disposable** CRM, it drives the product's own bootstrap over HTTP:
   - the integration-admin sign-in action, then `setStaffPassword` for one test employee;
   - action ids come from the build manifest;
   - the password comes from `E2E_STAFF_PASSWORD`, a fixed test value in the workflow, never printed.
   
   It writes nothing directly to the database. It works only where the bootstrap window is open: no credential yet and enforcement off, which is exactly a fresh disposable CRM.
5. **Switch-over.** No flag. The shared route is removed in the same change, and existing mobile sessions end on deploy (§2.2). **The Android release notes must say:**
   - every phone signs in again with the employee's own password;
   - the session lasts 12 h (`MOBILE_SESSION_TTL_SECONDS`) and autofill is off, so the password is typed at least every 12 h;
   - notifications resume after the new sign-in.
6. **E2E environment for a disposable CRM.** These are the names for the credential inventory review; all are test values, never printed:
   - `STAFF_SESSION_SECRET`: at least 32 bytes, not a placeholder, and different from `ADMIN_PASS` and `BOT_CRM_SECRET`. This plus a located registry makes `staffLaneStateV1() === 'ready'`;
   - `YOKO_USER_REGISTRY_FILE`: a writable path, e.g. under the job's temp dir;
   - `YOKO_USER_REGISTRY_SEED=once`: seeds that file from the image registry `gravity-mvp/src/data/users.json` while no StaffCredential row exists. That is where «Мария» (`u1`), Сидоров (`u2`) and Ремезов (`u3`) come from; the seed script creates no employee;
   - `ADMIN_USER` / `ADMIN_PASS`: the integration-admin bootstrap sign-in (`/settings/integrations/access`);
   - `E2E_STAFF_PASSWORD`: the test employee's personal password set through the bootstrap;
   - `STAFF_SESSION_REVOCATION_EPOCH` is optional (default `0`);
   - `MOBILE_ACCESS_USER` / `MOBILE_ACCESS_PASS` are **removed**;
   - `acceptance-seed.sql` creates no StaffCredential row, so the bootstrap window stays open. Both `next start` runs (main and push) can use the seed script, because the build manifest exists.
   - The acceptance workflow drops `MOBILE_ACCESS_*` and seeds a personal password. That is a workflow change on the Android side.

App-side rulings (Security): one generic refusal with no auto-retry; WebView autofill off (`IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS`); the password never stored on the device or logged.

## 4. Activation order (production)

1. `STAFF_SESSION_SECRET` and a persistent registry are in place.
2. The first Администратор is bootstrapped.
3. **Every employee who uses the phone has a personal password** (set by the Администратор on `/users`).
4. Deploy this change. All phones sign in again with their own password.
5. Then `YOKO_STAFF_SESSION_ENFORCE=on` (the enforce-deny note).

## 5. Proof (planned)

- **Unit tests** through the real proxy and action:
  - wrong password, unknown id, disabled employee, no credential: each gives the uniform `refused`;
  - the throttle applies and is shared with the browser lane;
  - an `operatorId` with another employee's password is refused;
  - extra operator-like fields are ignored;
  - the shared `MOBILE_ACCESS_*` username and password are refused, also when set in the environment;
  - a v1 token is refused;
  - the session ends on disable, re-create, password reset, revoke and browser logout, also when it is next used long after (an offline phone);
  - a demote between two requests: the second request sees the lower role;
  - push: a disabled, reset, revoked or browser-logged-out employee's registration is skipped at fan-out and at send time;
  - push: a registration with the shared subject is skipped;
  - push: an unreadable store skips and never sends;
  - push-registration: 401 `MOBILE_SESSION_REVOKED` for the barrier and for a liveness end, 503 `MOBILE_SESSION_UNVERIFIABLE` for an unreadable store;
  - the audit actors stay distinct: `mobile:` for the phone, `staff:` for the browser;
  - no password or password field in any log line or refusal (byte scan of the captured console);
  - a mobile logout leaves the desktop session;
  - an unreadable store gives 503 in the shell lane;
  - BR-4 with both cookies.
- **PostgreSQL test:** real StaffCredential rows; an epoch bump ends the mobile session.
- **Mutants:**
  - fallback to the shared pass;
  - operator taken from the request instead of the verified id;
  - epoch not checked;
  - unreadable store treated as valid;
  - throttle bypass;
  - staff key reused for mobile;
  - v1 accepted.
- **Heavy production-build E2E:** a personal sign-in on `/login/mobile`, the shared pass refused, the session ending on a browser logout.

## 6. Security rulings (early comments, 2026-11-11)

- **Throttle source across lanes (for Security's ruling).** The `source:<x-real-ip>` key is shared by both lanes, as for the browser login today. In an office behind one NAT, repeated failures by one person throttle sign-in for everyone behind that address, phones and browsers alike, for the throttle window. The per-user key stays the main defence. Proposed: accept it, as already accepted for the browser login in Staff Session v1.3.

- **O1:** kind `login` / `logout` with actor `mobile:<id>` is accepted, with no migration (§2.1 step 6).
- **O2:** a mobile logout ends only that phone session. "Everywhere" is a password reset or a revoke.
- **O3:** the role is read live, and a demote need not end sessions. A test proves the lower role on the next request.

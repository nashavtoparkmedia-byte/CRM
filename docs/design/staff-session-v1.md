# Staff Session v1 — a verified browser identity for the CRM's existing employees

**Status: DESIGN v1.3 (2026-11-08), identity_access owner: «YOKO CRM — Identity Access — PC» (Owner mandate, Orchestrator V8). v1.2 (beafd6d8) had the Security DESIGN PASS. v1.3 changes exactly four decisions (D1–D4), listed in §0; they need a Security DESIGN verdict of their own. Everything else is v1.2 unchanged. No code of this design has landed.**
Owner context: `identity_access`.

## 0. What v1.3 changes, and why

The Owner's clarification (2026-11-08): the CRM already has employees, roles and user management; the task is to finish their secure authorization, not to build a second employee system. v1.2 is treated as a verified hypothesis. Checked against the repository:

1. **The authority for an employee, their role and status is the existing registry**: `gravity-mvp/src/data/users.json`, read only through `getUsers()` in `src/lib/users/user-service.ts` (identity_access-owned; no other file reads it), written only by `addUser` / `updateUser` / `deleteUser` behind `/users`, exposed as `UserIdentity.v1` / `CurrentUserQuery.v1`. `CrmUser` (`crm_users`) is a different namespace (work-management task assignees, roles `manager`/`lead`), not the login registry; nothing changes there.
2. **Reusable as is:** the HMAC session envelope, constant-time checks, TTL, revocation epoch and server-minted `sid` of the integration-admin and mobile sessions; BR-4's single resolver (`resolveCookieOperatorV1`) and the proxy's Cookie rewrite (`withLegacyUiIdentityCookieV1`), which make every one of the ~30 `crm_user_id` readers see only the verified operator without edits; `/login` (choose an employee) and `/users` (manage them); `getCurrentUser`; `auth-helpers.js` (`canManageUsers`, `isValidRole`, the last-privileged invariants); `isExactSameOriginMutationRequest`.
3. **What is really missing:** an individual secret per employee and a place to keep its verifier; a signed browser session that names the employee; server-side revocation; user management authorized by that session instead of the unsigned `crm_user_id`; the browser-lane branch in BR-4.
4. **Yes, without a second registry.** The only new data is the credential verifier and its revocation counter (§4.1). It holds no name, role or status, cannot list or create an employee, and grants nothing unless the registry record it is bound to exists, is `Активен` and has the bound `createdAt`.
5. **Yes, v1.2 created an avoidable consistency problem.** Its PostgreSQL "authority copy" of `role` and `status`, required to equal the file at every verification, made every role or status change a write to two stores with no atomic mechanism between them. It failed closed, but every partial failure, and every redeploy after any runtime change (the image restores the build-time file), would lock the affected employees out until a repair. It also gave authority two writers.

**v1.3 decisions:**

- **D1 — no authority copy.** Role and status are read from the registry at every verification, as v1.1 did. The credential row keeps only the record binding (`userId`, `registryCreatedAt`) that stops a reused id from inheriting a credential.
- **D2 — revocation is carried by the credential, written first.** Disabling or deleting an employee first revokes their credential in PostgreSQL (one transaction), then writes the registry. The order is the mechanism: if the registry write fails, or a redeploy restores the old file, the employee is still `Активен` in the file but holds no credential and cannot sign in. Re-enabling requires an Администратор to set a new password. No step claims atomicity across the file and the database.
- **D3 — the registry must be durable before enforcement is switched on.** The one gap D2 cannot close is a role change undone by a redeploy (for example an Администратор demoted, then restored by the image). That is the existing registry's storage problem — today a redeploy already loses every employee added through `/users` — so it is fixed at the root: the registry path becomes configurable (`YOKO_USER_REGISTRY_FILE`), the image's file is only the first-start seed, writes become atomic, and production activation (`YOKO_STAFF_SESSION_ENFORCE=on`) has the precondition "the registry is on persistent storage". No copy of the registry is kept anywhere.

- **D4 — the user-management guard is dormant with the rest.** v1.2 made it active at merge, which would close `/users` for everyone until the first bootstrap — an access change in MAIN. Instead it is strict exactly when the staff lane is configured (`STAFF_SESSION_SECRET` valid): no Staff Session can exist without the secret, and the browser lane is then the legacy trusted-app model, where a role in `users.json` grants no verified authority. From the moment the secret is set (the first activation step, before any bootstrap), add, delete, role, status and credential writes require a Staff Session Администратор. Removing the secret later returns the whole browser lane to the legacy model.

For consumers nothing changes from v1.2: `getStaffSessionPrincipalV1()` returns `StaffSessionPrincipalV1 { kind: 'staff_session', userId, role, sid, issuedAt, expiresAt }`, with `sid` a non-secret per-login id (a labelled sha256 of the token's random instance id) and `issuedAt` the password login time (there is no re-issue without a password).

The Basic-auth question of the mandate is answered in §4.6; the narrow Cash contract ships separately (§8, PR-IA1).

## 1. Why

The browser CRM has no verified employee identity:

- `crm_user_id` is an **unsigned** cookie set by `login(targetUserId)`; anyone with browser access picks an identity from the registry (`UserItem { id, firstName, lastName, email?, phone?, role: 'Менеджер' | 'Руководитель' | 'Администратор', status, createdAt }`). About thirty server files read `crm_user_id` directly.
- The only verified server-side principals are the **integration-admin session** (`yoko_integration_admin_session`, one shared `ADMIN_USER`/`ADMIN_PASS`, a capability, not a person) and the **Android mobile session** (`yoko_mobile_session`), whose operator BR-4 (#197) makes authoritative for the shell lane.
- Consumers wait for an employee principal: «Люди» (`ContactPersonCardQuery.v1`, `ContactLookup.v1`) and the Cash referral manager tools answer only the shared integration-admin session today, so an employee signs in a second, administrative time to use them (G-R2: a shared admin capability is not an employee's authority).

## 2. Non-goals

- No second employee registry, no copy of role or status, no new roles, no multi-tenant attribution, no OAuth/SSO, no e-mail reset, no MFA, no device binding, no concurrent-session limit.
- No change to Cash, Contacts, Messaging or Android rules in this design; each consumer admits `staff_session` in its own change (§4.7).
- No change to the Android lane's semantics (BR-4) or to the integration-admin ceremonies.
- `crm_user_id` is not removed; it stops being authority and remains a UI selector derived from the session.

## 3. The credential

An individual password per employee. Its verifier and the employee's revocation counter live in a **PostgreSQL table owned by identity_access**, not in `users.json`: the repository is public, the file is tracked and baked into the image, and `getUsers()` returns whole `UserItem` objects to anonymous `/login`. The registry's field set does not change.

Rejected: a shared staff password plus a free choice of user (it proves possession of a secret, not the person).

## 4. Mechanism

Reused from `integration-admin-credentials.ts` / `mobile-session-credentials.ts`: base64url payload + HMAC-SHA256, `timingSafeEqual`, TTL, revocation epochs, server-minted `sid`, HttpOnly/Secure cookie. **Different on purpose:** the staff session is keyed with a dedicated signing secret that is never a login credential.

### 4.1 Storage (identity_access, PostgreSQL, expand-only migration)

```
StaffCredential {
  userId            String   @id        -- the registry UserItem.id
  registryCreatedAt String              -- the registry record's createdAt at binding: a reused id inherits nothing
  algo              String              -- 'scrypt'
  n, r, p           Int                 -- 32768, 8, 1
  maxmemBytes       Int                 -- 67108864 (64 MiB)
  salt              Bytes               -- 16 random bytes
  hash              Bytes               -- 64 bytes
  sessionEpoch      Int      @default(0) -- bumped by logout, password set/reset, role change
  revokedAt         DateTime?           -- set by disable/delete (D2); a revoked row verifies nothing
  createdAt, updatedAt DateTime
  updatedBy         String              -- 'staff:<userId>' | 'integration-admin'
}
StaffCredentialEvent { id, userId, kind ('password_set'|'password_reset'|'epoch_bump'|'revoked'|'login'|'logout'), actor, sid?, recordedAt }  -- append-only audit
```
No name, role or status column (D1). Every write to this table is one transaction under one advisory lock (`pg_advisory_xact_lock` on a fixed identity_access key), so the set-level checks (bootstrap window, last credentialed Администратор) are serialized.

### 4.2 Token and cookie

| Element | Value |
|---|---|
| Cookie | `__Host-yoko_staff_session`: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. |
| Signing key | `STAFF_SESSION_SECRET` (C-class). Identity Access refuses to issue or verify when it is absent, shorter than 32 bytes, a placeholder, or equal to `ADMIN_PASS`, `MOBILE_ACCESS_PASS` or `BOT_CRM_SECRET`. |
| Payload | `{ v: 1, aud: 'yoko-staff-session', sub: userId, iat, exp, epoch, uepoch, sid }` — `epoch` = `STAFF_SESSION_REVOCATION_EPOCH`; `uepoch` = `StaffCredential.sessionEpoch` at issue; `sid` = 16 server-random bytes. No role in the token. |
| TTL | 12 h. |
| Verify | `getStaffSessionPrincipalV1()`: signature; `v`; `aud`; `exp`; global `epoch`; the credential row exists, is not revoked, its `sessionEpoch` equals `uepoch`; the registry record `sub` exists, is `Активен` and has `createdAt === registryCreatedAt`. The role is the registry's, read now. Any mismatch → `null`. **Unverifiable = refused (R3):** a store that cannot be read while a staff cookie is present gives no operator and a 503 on the browser lane, never a fallback to `crm_user_id`. |
| Principal | `StaffSessionPrincipalV1 { kind: 'staff_session', userId, role, sid, issuedAt, expiresAt }` (v1.2 field names); `sid` is a labelled sha256 of the token's instance id, never a token digest; `issuedAt` is the password login time. Consumers take authority only from `getStaffSessionPrincipalV1()`, never from `getCurrentUser()`. |

### 4.3 Login, logout, revocation

- `staffLogin(userId, password)` — a Server Action; `/login` keeps choosing the employee and gains the password step. Load the registry record (must be `Активен`) and the credential; async `crypto.scrypt` (`N=2^15, r=8, p=1, maxmem 64 MiB`); for an unknown, disabled or credential-less user the same dummy scrypt; `timingSafeEqual`; on success set the cookie (and `crm_user_id` = userId for the UI); on failure one uniform refusal. Password rules: 10–256 characters, placeholder and common-password denylist.
- At most 4 scrypt verifications in flight per instance; beyond that a brief wait, then 503.
- Exponential backoff per user and per source (`X-Real-IP` set by the edge), in memory: documented residual risk behind the edge gate.
- `staffLogout()` deletes the cookie and bumps `sessionEpoch` (every session of that employee ends server-side). «Выйти на всех устройствах» is the same bump; `STAFF_SESSION_REVOCATION_EPOCH` ends all sessions.
- No GET with a side effect accepts `staff_session` as authority; mutating Route Handlers keep `isExactSameOriginMutationRequest`.

### 4.4 User management (B2, B3, D2, D3)

- `/users` stays the one place employees are managed. While the staff lane is configured (D4), `addUser`, `updateUser`, `deleteUser` and password administration require a **Staff Session**; add, delete, role and status changes, and any write to an employee who holds a credential, require role **Администратор**; Администратор is granted only by an Администратор. `updateUser` applies an explicit field allowlist (`firstName, lastName, email, phone, role, status`).
- **Order of writes (the D2 mechanism).** Each change touches at most two stores and never claims they change together:
  - disable or delete: (1) PostgreSQL: `revokedAt = now`, `sessionEpoch + 1`, event `revoked` — one transaction; (2) the registry write. (1) failing aborts the change. (2) failing leaves an employee who cannot sign in; the action reports the error and can be repeated.
  - role change: (1) `sessionEpoch + 1`; (2) the registry write. (2) failing leaves the old role in force and the old sessions ended: consistent.
  - add, rename, contact data: the registry only.
  - enable: the registry only; the employee has no live credential until an Администратор sets a password.
- **Registry writes are serialized and atomic.** One in-process writer; the file is written to a temporary file in the same directory, flushed, then renamed over the registry (a reader sees the old or the new file, never a torn one). New ids are `randomUUID()` (the `"u" + (n + 1)` scheme reused ids).
- **Registry durability (D3).** `YOKO_USER_REGISTRY_FILE` (default: the current in-image path, unchanged for development and for the dormant state). When it names a file that does not exist yet, the image's `src/data/users.json` seeds it once (exclusive create). Production activation requires it on persistent storage; until then the documented residual is "a redeploy can undo a role change", exactly as today, while disable and delete stay effective (D2).
- **Bootstrap (R2).** The integration-admin session may set a first credential only for an employee without one, and only while no Администратор holds a live credential; it can never reset one. Audited as `actor=integration-admin`. `ADMIN_PASS` is rotated before the first production bootstrap.
- The last-privileged invariants count Администратор employees **with a live credential**.

### 4.5 One operator resolution (BR-4)

- `resolveCookieOperatorV1` gains a `staff_session` branch; `proxy.ts` rewrites the Cookie header on the browser lane exactly as on the shell lane: a valid staff session → downstream readers see exactly one `crm_user_id = sub`; a refused staff session, or `YOKO_STAFF_SESSION_ENFORCE=on` without one → no `crm_user_id`.
- Both `yoko_mobile_session` and `__Host-yoko_staff_session` in one request → no operator.
- `YOKO_STAFF_SESSION_ENFORCE` acts on the browser lane only; the shell lane is unchanged.

### 4.6 The edge perimeter: one Basic-auth challenge, not several (mandate gate 2)

Today a browser user meets: the edge staff gate (`auth_basic "YOKO CRM"`, personal htpasswd line), then on `/compensation` a second realm (`"YOKO compensation"`, a separate htpasswd), then the CRM user choice, then the integration-admin login for «Люди» and the Cash tools. Browsers cache Basic credentials per realm and send the last accepted ones preemptively, so two realms with different files re-challenge on `/compensation` and can flip between the two credentials (page assets go to the staff realm, the page to the Cash realm).

Decision (edge_delivery change, proposed to its owner; not in the identity_access PR):
- `/compensation` keeps its own allowlist file but uses **the same realm string, `"YOKO CRM"`**, and its lines are **byte-identical copies of the chosen people's staff lines** (same user, same hash). The browser's cached staff credential then satisfies both checks: one prompt per browser session.
- A staff member who is not on the Cash list still gets 401 on `/compensation` (no enumeration difference: wrong password and not-listed look the same). Who may reach `/compensation` at all is unchanged; what is dropped is a second password for the same person, while every Cash write still needs that person's Staff Session (§4.7) — a separate secret, checked by the application.
- Not done, because it would weaken the perimeter: trusting an edge-supplied user header as the application login (the application is reachable without nginx in some topologies), or removing the edge gate once Staff Session exists.
- The application-side repetition — the second, administrative login — disappears when the consumers admit `staff_session` (§4.7).
- Also documented: `yokoone.ru` and `app.yokoone.ru` are separate origins (separate Basic caches and `__Host-` cookies); the planned 301 of the legacy host removes that duplication.

### 4.7 Consumer contracts (identity_access publishes; each owner adopts)

- `getStaffSessionPrincipalV1()` — above; kind `staff_session`.
- Contacts: `identityAccessContactPersonCardAuthorityV1` and the lookup route admit `kind === 'staff_session'` beside `integration_admin_session` (one file, Contacts owner).
- Cash: consumes only `getStaffSessionPrincipalV1()`; its binding to `cash.referral.qualify` / `cash.access.manage` by role is Cash's own (docs/design/cash-staff-authority-v2.md, Cash owner).
- Messaging needs no change: its readers see the verified operator through the BR-4 rewrite.

## 5. Invariants

- A client-held value (`crm_user_id`, a header, a body field) never influences who the principal is — on login, on every read and on every user-management write.
- Password material never leaves the server; no password, hash or cookie in logs, error bodies, `getUsers()` or any client payload.
- A disabled, deleted, re-created, expired, forged, replayed-after-epoch, wrong-`aud`, wrong-`v` session is `null` — fail closed.
- Role and status have one authority, the registry; nothing copies them.
- Disable and delete are effective server-side even if the registry write is lost (D2).
- The legacy `login(targetUserId)` works only while `YOKO_STAFF_SESSION_ENFORCE` is off and only for an employee without a live credential.

## 6. Threats considered

| Threat | Answer |
|---|---|
| Forged / chosen `crm_user_id` | not authority; the proxy rewrite shows readers only the resolved operator |
| Stolen cookie | 12 h TTL; logout and credential changes bump `sessionEpoch`; global epoch; `__Host-`, HttpOnly, Secure |
| Password guessing | scrypt 2^15/8/1, 64 MiB; dummy scrypt; per-user and per-source backoff; denylist; uniform refusal |
| Memory DoS via scrypt | 4-slot limiter, 503 beyond it |
| Escalation via user management | Staff Session Администратор required; field allowlist; Администратор granted only by Администратор; epoch bump on role change |
| Master key through bootstrap | first credential only, never reset, only while no Администратор holds a live credential; `ADMIN_PASS` rotated first |
| Registry write lost or rolled back by a redeploy | disable/delete revoked in PostgreSQL first (D2); role-change rollback closed by durable registry storage before activation (D3) |
| Reused registry id | random ids; `registryCreatedAt` binding; delete revokes first |
| Unreadable credential store with a staff cookie | no operator, 503, no fallback |
| Two sessions in one request | no operator |
| CSRF | Server Actions under Next's Origin/Host check; same-origin checks on Route Handlers; no side-effecting GET under `staff_session` |
| Repeated edge challenges | one realm, identical lines (§4.6); no weaker perimeter; the Android shell's realm rule (it answers only "YOKO CRM") is re-checked by Android before the edge change |
| Accepted residual risk | an Администратор can reset a password and act as that employee (audited); in-memory backoff resets on restart; until D3 is met a redeploy can undo a role change |

## 7. Data and configuration

- Migration (identity_access, expand-only): `StaffCredential`, `StaffCredentialEvent`.
- Env: `STAFF_SESSION_SECRET` (C-class), `STAFF_SESSION_REVOCATION_EPOCH` (default `0`), `YOKO_STAFF_SESSION_ENFORCE` (default off), `YOKO_USER_REGISTRY_FILE` (default: current path).
- `docs/SECRETS.md`, `docs/CRM_ENGINEERING_MAP.md` (§2.8 Identity Access, Login row, a new invariant).

## 8. Delivery and gates

1. ~~PR-IA1 (`IntegrationAdminSessionFacts.v1`)~~ — dropped: the Owner moved Cash to `getStaffSessionPrincipalV1()` (Cash consumer alignment, 2026-11-08).
2. **This document v1.3** → Security DESIGN verdict on D1–D4 and §4.6 only.
3. **Implementation PR** (identity_access): migration, credential module, scrypt verifier with limiter and dummy path, `/login` password step, logout, `getStaffSessionPrincipalV1` / `getStaffSessionFactsV1`, resolver and proxy branch, user-management guards with the D2 write order and atomic registry writes, boundary control, Engineering Map, SECRETS.md. Dormant by default (no secret, enforcement off), the user-management guard included (D4). Independent Security implementation review + hosted CI.
4. **Consumer PRs** by their owners (Contacts, Cash), edge PR (§4.6) by edge_delivery.
5. Activation (separate Owner GO): secrets rotated, registry on persistent storage, first credential bootstrapped, enforcement on.

## 9. Acceptance (summary)

Positive: an employee with a credential signs in once and opens «Люди», Messaging and the Cash tools without another login; logout ends every session of that employee; an Администратор sets or resets a password and the old sessions die.
Negative: wrong password → uniform refusal (same timing for unknown users); disabled or deleted employee → refused, also after the registry write fails or the file is restored; expired/tampered/wrong-aud cookie → anonymous; role changed → old session invalid; another `crm_user_id` with a valid session → ignored; mobile + staff cookies → no operator; a Менеджер cannot manage users with or without enforcement; the integration-admin session cannot reset a credential.
Regression: integration-admin ceremonies, the Android lane (BR-4), RCQ1/CC-1, Cash's fail-closed actor rule unchanged; architecture controls PASS.

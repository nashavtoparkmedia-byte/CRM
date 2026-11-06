# Staff Session v1 — a verified browser identity for one CRM employee

**Status: DESIGN v1.2 — revised after the Security DESIGN review (2026-11-07: B1–B5, M1–M8 closed in v1.1; N1, R2, R3 applied in v1.2). Awaiting Identity Access domain-owner agreement and the Security DESIGN PASS. No code of this design has landed.**
Owner context: `identity_access`. Mandate: Orchestrator V7 Contact Identity full conditional delivery mandate, 2026-11-07 (§7).

## 1. Why

The browser CRM has no verified employee identity:

- `crm_user_id` is an **unsigned** cookie set by `login(targetUserId)` in `gravity-mvp/src/lib/users/user-service.ts`; anyone with browser access picks an identity from the registry `src/data/users.json` (`UserItem { id, firstName, lastName, email?, phone?, role: 'Менеджер' | 'Руководитель' | 'Администратор', status, createdAt }`). `canLogin` only prevents a Менеджер from re-picking another id; it proves nothing. About twenty server files read `crm_user_id` directly (`assertCanManageUsers`, `assertCanEditAi`, tasks/my-day actions, SIP credentials, group visibility, …), not through `getCurrentUser`.
- The only verified server-side principals are the **integration-admin session** (`yoko_integration_admin_session`, HMAC over `{sub, iat, exp}`, 8 h, one shared `ADMIN_USER`/`ADMIN_PASS` — a capability for integration ceremonies, not a person; `ADMIN_PASS` is also the tg-bot admin credential and lived on the lost Beget host) and the **Android mobile session** (`yoko_mobile_session`, HMAC over `{sub, did, iat, exp, sid}`, 12 h, `MOBILE_ACCESS_USER`/`MOBILE_ACCESS_PASS`, `MOBILE_SESSION_REVOCATION_EPOCH`), whose operator BR-4 (#197) makes authoritative for the shell lane by resolving it once (`resolveRequestOperatorV1`) and rewriting the `Cookie` header in `proxy.ts` so every downstream reader sees exactly that operator.
- Consumers already wait for an employee principal: the Contact person card (`ContactPersonCardQuery.v1`) and `ContactLookup.v1` answer only the integration-admin principal today (engineering mode; G-R2: a shared admin capability is not an employee's authority); Cash records a manual decision only from `{ kind: 'signed_staff_session', principalId, capabilities }`.

The first real scenario is **one manager** using the person card. The design reuses the proven HMAC-session mechanism, keeps the user registry for the employee directory, and adds what the browser lane lacks: an individual credential, held server-side, plus server-side revocation.

## 2. Non-goals

- No multi-tenant / park attribution, no roles beyond the three that exist, no OAuth/SSO, no e-mail password reset, no MFA, no device binding, no concurrent-session limit, no new IAM platform.
- No change to Cash authorization rules. Mapping `staff_session` → Cash's `signed_staff_session` actor with capabilities is a **separate Cash-owned decision**.
- No change to the Android lane's semantics (BR-4) or to the integration-admin ceremonies.
- `crm_user_id` is not removed in v1; it stops being authority (§5) and remains a UI selector derived from the session until the browser lane is closed (R-01) by a separate decision.

## 3. The one minimal decision for the Owner

**Credential: an individual password per CRM user.** Its hash and the user's revocation epoch live in a **durable server-side store owned by identity_access**, not in `users.json`: the repository is public, `src/data/users.json` is tracked and `COPY`-ed into the production image (writes there die with the container), and `getUsers()` is a `'use server'` action that returns whole `UserItem` objects to anonymous `/login` and to `/users` — anything added to that file reaches the browser. The directory (`users.json`) therefore stays as it is; the credential is the new table below.

Rejected: a shared staff password plus a free choice of user — it proves possession of a secret, not the person, so every audit line (`mergedBy`, `confirmedBy`, Cash actor) would still name an unproven employee.

## 4. Mechanism

Reused from `integration-admin-credentials.ts` / `mobile-session-credentials.ts`: base64url payload + `HMAC-SHA256`, `timingSafeEqual`, TTL, revocation epochs, HttpOnly/Secure cookie. **Different on purpose:** those mechanisms key the HMAC with the access password itself (`createHmac('sha256', config.password)`); the staff session is keyed with a **dedicated signing secret** that is never a login credential.

### 4.1 Storage (identity_access-owned, Postgres, expand-only migration)

```
StaffCredential {
  userId            String   @id        -- the registry UserItem.id (random, immutable; see N1)
  registryCreatedAt DateTime            -- the registry record's createdAt at binding time: a reused id inherits nothing
  role              String              -- the durable authority copy: 'Менеджер' | 'Руководитель' | 'Администратор'
  status            String              -- the durable authority copy: 'Активен' | 'Отключен' | 'Удалён'
  algo              String              -- 'scrypt'
  n, r, p           Int                 -- 32768, 8, 1
  maxmemBytes       Int                 -- 67108864 (64 MiB)
  salt              Bytes               -- 16 random bytes
  hash              Bytes               -- 64 bytes
  sessionEpoch      Int      @default(0) -- bumped by logout, password set/reset, role/status change, delete
  createdAt, updatedAt  DateTime
  updatedBy         String              -- actor: 'staff:<userId>' | 'integration-admin'
}
StaffCredentialEvent { id, userId, kind ('password_set'|'password_reset'|'epoch_bump'|'login'|'login_refused'|'logout'|'revoked'), actor, sid?, recordedAt }  -- append-only audit
```
Password set/reset, epoch bump and every role/status/delete change are single database transactions (atomic; M7). Nothing credential-shaped is ever added to `users.json`, and `getUsers()` keeps its field set.

**Durable authority (N1).** `users.json` is baked into the production image, so a file edit is rolled back by the next deployment: a disabled or demoted employee would be active or privileged again. Therefore the table above holds the **authority copy** of `role` and `status`, written in the same transaction as the registry change and the epoch bump, and verification requires the registry record and the table to agree (`id`, `registryCreatedAt`, `role`, `status`); any disagreement — a rolled-back file, a re-created id, a stale copy — answers `null`. `deleteUser` revokes the credential atomically (`status = 'Удалён'`, epoch bump, audit `revoked`); registry ids are generated with `randomUUID()` and are immutable (today's `"u" + (users.length + 1)` is retired, because a deleted id could be reused and inherit a credential). The infrastructure alternative — a persistent volume for `src/data` — remains an Owner decision and is not assumed.

### 4.2 Token and cookie

| Element | Value |
|---|---|
| Cookie | `__Host-yoko_staff_session`: Secure, HttpOnly, SameSite=Lax, Path=/, **no Domain** (isolates `yokoone.ru` from `app.yokoone.ru`). |
| Signing key | `STAFF_SESSION_SECRET` (C-class, `docs/SECRETS.md`). At startup Identity Access **refuses to issue or verify** (fail closed, one error line) when it is absent, shorter than 32 bytes, a placeholder, or equal to `ADMIN_PASS`, `ADMIN_SESSION_SECRET`, `MOBILE_ACCESS_PASS` or `BOT_CRM_SECRET`. |
| Payload | `{ v: 1, aud: 'yoko-staff-session', sub: userId, iat, exp, epoch, uepoch, sid }` — `epoch` = `STAFF_SESSION_REVOCATION_EPOCH`; `uepoch` = `StaffCredential.sessionEpoch` at issue; `sid` = random session instance id. **No role in the token**: the role is read from the registry at every verification. |
| TTL | 12 h. |
| Verify | `getStaffSessionPrincipalV1()`: signature; `v === 1`; `aud`; `exp`; `epoch` equals the current global epoch; `uepoch` equals the stored `sessionEpoch` (one indexed read); the registry user exists, is `Активен`, and matches the table's authority copy (`registryCreatedAt`, `role`, `status`). Any mismatch → `null`, never a partial principal. **Unverifiable = refused (R3):** when the store cannot be read (database unavailable, timeout) while a staff cookie is present, the request has **no operator** — no fallback to `crm_user_id` — and the browser lane answers **503**, as BR-4's unreadable logout barrier does for the shell lane; it is never treated as a logout. |
| Principal | `StaffSessionPrincipalV1 { kind: 'staff_session', userId, role, sid, issuedAt, expiresAt }` — exported from `identity_access.public.v1`. Consumers derive capabilities from `role` through their own policy. **Consumers take authority only from `getStaffSessionPrincipalV1()` (kind `staff_session`), never from `getCurrentUser()`**, which still answers the legacy cookie while enforcement is off (M6). |

### 4.3 Login, logout, revocation

- `staffLogin(userId, password)` — a Server Action (`/login` gains a password step after the user is chosen). Next's built-in Origin/Host check protects it; `serverActions.allowedOrigins` stays unset. Steps: load the registry user (must be `Активен`) and its `StaffCredential`; run `crypto.scrypt` (async; `N=2^15, r=8, p=1, maxmem 64 MiB`; measured ≈ 80 ms) — for an unknown user or one without a credential run the **same dummy scrypt** so timing does not reveal who has a credential; compare with `timingSafeEqual`; on success issue the cookie and derive `crm_user_id = userId`; on failure a uniform error and one structured refusal line. Password rules: 10–256 characters, placeholder rejection as `rejectsAsPlaceholder`, plus a denylist of common passwords.
- Concurrency: at most 4 scrypt verifications in flight per instance; further attempts wait briefly, then are refused with 503 (each verification pins ≈ 32 MiB).
- Brute force: exponential backoff per user **and** per source (`X-Real-IP`, trusted only when set by the nginx edge), in memory for v1 — acceptable only behind the P0 edge gate; the limits and their reset-on-restart are documented residual risk.
- `staffLogout()` — Server Action; deletes the cookie **and bumps `sessionEpoch`**, so every session of the user, including a stolen one, is invalid server-side at once. Every password set/reset also bumps `sessionEpoch`.
- «Выйти на всех устройствах» = the same bump, by the user or an Администратор; `STAFF_SESSION_REVOCATION_EPOCH` invalidates all sessions.
- No GET with a side effect accepts `staff_session` as authority (SameSite=Lax sends the cookie on top-level cross-site GET); Route Handlers that mutate keep `isExactSameOriginMutationRequest`.

### 4.4 Credential administration (B2, B3)

- `setStaffPassword(targetUserId, newPassword)`: allowed for the user themself (with the current password) or for an **Администратор under a Staff Session**. Audit line names actor and target.
- **Bootstrap only, and only while the system has no credentialed Администратор (R2):** the integration-admin session may set a credential only for a user who has none yet, and only while **no user with role Администратор holds a credential**; from the moment one does, the first password of every new user is set by a Staff Session Администратор, and the integration-admin path is closed (so a holder of `ADMIN_PASS` cannot claim new accounts indefinitely). It can never reset an existing credential; every bootstrap is audited as `actor=integration-admin`. Operational precondition, recorded in `docs/SECRETS.md`: `ADMIN_PASS` is rotated before the first bootstrap (the Beget copy is considered exposed).
- Same timing for a disabled user as for an unknown one (dummy scrypt); `login_refused` for an id that does not exist in the registry is written to the structured log only, never to `StaffCredentialEvent`, so a guesser cannot grow the table; the last-privileged invariants (`wouldDeleteLastPrivileged` / `wouldDemoteLastPrivileged`) count Администратор users **with a credential**, so the system is never left without a manageable administrator.
- User management (`addUser`, `updateUser`, `deleteUser`, role and status changes) — **from the implementation PR on, regardless of `YOKO_STAFF_SESSION_ENFORCE`** — requires a Staff Session; role and status changes, add, delete and any write to a user who holds a credential require role **Администратор**; the role Администратор is granted only by an Администратор (`canManageUsers` no longer suffices for Руководитель here). `updateUser` applies an **explicit field allowlist** (`firstName, lastName, email, phone, role, status`); credential and epoch fields are never writable through CRUD. A role or status change bumps the target's `sessionEpoch`.

### 4.5 One operator resolution (B4)

After #197 lands, the staff session is added to the **same** BR-4 mechanism, never beside it:

- `resolveRequestOperatorV1` / `resolveCookieOperatorV1` gain a `staff_session` branch; `proxy.ts` rewrites the `Cookie` header on the browser lane exactly as on the shell lane: a valid staff session → downstream readers see **exactly one** `crm_user_id = sub`; a refused staff session, or `YOKO_STAFF_SESSION_ENFORCE=on` without a session → `crm_user_id` is **removed**, so the ~20 direct cookie readers and `getCurrentUser` all fail closed without edits.
- Both `yoko_mobile_session` and `__Host-yoko_staff_session` present in one request → **no operator** (refused), logged once.
- `YOKO_STAFF_SESSION_ENFORCE` acts on the browser lane only; the shell lane keeps BR-4 semantics unchanged.
- A staff cookie that cannot be verified because the store is unreadable → no operator and 503 for the browser lane (R3); never a silent fallback to the legacy cookie.
- `contacts`: `identityAccessContactPersonCardAuthorityV1` and the lookup route admit `kind === 'staff_session'` beside `integration_admin_session` — one named kind in one file.

## 5. Invariants

- A client-held value (`crm_user_id`, a header, a body field) never influences who the principal is — on login, on every read **and on every user-management write** (B2).
- Password material never leaves the server; hashes live only in `StaffCredential`; no password, hash or cookie appears in logs, error bodies, `getUsers()` or any client payload.
- A disabled user, an expired, forged, replayed-after-epoch, wrong-`aud`, wrong-`v` or role-stale session is `null` — fail closed.
- Role comes from the registry at verification; a Менеджер cannot become anything else by any login or CRUD path.
- Logout and every credential change are effective server-side immediately (epoch), not only in the browser.
- The legacy `login(targetUserId)` without a password works only while `YOKO_STAFF_SESSION_ENFORCE` is off and only for a user without a credential (migration window); user management never falls back to it.

## 6. Threats considered

| Threat | Answer |
|---|---|
| Forged / chosen `crm_user_id` | not authority anywhere; the proxy rewrite makes downstream readers see only the resolved operator |
| Stolen cookie | TTL 12 h; server-side logout and credential changes bump `sessionEpoch`; global epoch; `__Host-`, HttpOnly, Secure |
| Password guessing | scrypt 2^15/8/1 with 64 MiB maxmem; dummy scrypt for unknown users; per-user and per-source exponential backoff; denylist; uniform refusal |
| Memory DoS via scrypt | async scrypt with a 4-slot limiter, 503 beyond it |
| Shared / weak password | individual per user; 10–256 chars; placeholder and common-password denylist |
| Escalation via user management | Staff Session Администратор required for role/status/add/delete; field allowlist; Администратор granted only by Администратор; epoch bump on role change |
| Master key through bootstrap | integration-admin may only set a **first** credential, never reset, and only while no Администратор holds a credential; `ADMIN_PASS` rotated before bootstrap; audited |
| Authority rollback by redeploy (`users.json` baked into the image) | `role`/`status` authority copy in `StaffCredential`, written with the registry change; verification requires agreement; a rolled-back file refuses instead of re-enabling |
| Reused registry id inheriting a credential | random immutable ids; `registryCreatedAt` bound at credential creation and checked at verify; `deleteUser` revokes atomically |
| Unreadable credential store with a staff cookie | refused: no operator, 503 on the browser lane, no legacy-cookie fallback |
| Two sessions in one request | no operator |
| CSRF | Server Actions under Next's Origin/Host check (allowedOrigins unset); Route Handlers keep same-origin checks; no side-effecting GET under `staff_session` |
| Key reuse / weak key | dedicated secret, startup refusal on length/placeholder/equality with other secrets; rotation = new secret + global epoch |
| Timing leak of who has a credential | dummy scrypt |
| Accepted residual risk (v1) | an Администратор can reset a user's password and act as them — visible in the audit; no device binding, MFA or concurrent-session limit; phishing; in-memory backoff resets on restart and can be aimed at one user (mitigated by the edge gate) |

## 7. Data and configuration changes

- Migration (identity_access, expand-only): `StaffCredential`, `StaffCredentialEvent`. No change to `users.json` or its field set.
- New env: `STAFF_SESSION_SECRET` (C-class), `STAFF_SESSION_REVOCATION_EPOCH` (default `0`), `YOKO_STAFF_SESSION_ENFORCE` (default off). `docs/SECRETS.md` gains the rows and the bootstrap precondition (rotate `ADMIN_PASS` first).
- `docs/CRM_ENGINEERING_MAP.md`: §2.8 Identity Access, the Login row, a new invariant (number assigned at landing), R-01 narrowed, the ownership of the user-management guards.

## 8. Delivery and gates

1. **This document** → Identity Access domain-owner agreement (Orchestrator) + Security delta re-review of v1.1 (B1–B5, M1–M8).
2. **Implementation PR** (identity_access; after #197 has landed, since it extends BR-4's resolver and proxy rewrite): migration, credentials module + tests (issue/verify/tamper/expiry/aud/v/epoch/disabled user/role change), scrypt verifier with limiter and dummy path, login/logout actions + `/login` password step, `getStaffSessionPrincipalV1`, resolver and proxy branch, user-management guards and allowlist, boundary control, Engineering Map, SECRETS.md. Dormant by default (`YOKO_STAFF_SESSION_ENFORCE` off, no credential yet), except the user-management guard which is active immediately. Independent review + hosted CI.
3. **Contacts PR** (one authority file + checker): admit `staff_session` in the person-card authority and lookup route.
4. **Independent Security review** of the implementation; secrets rotated (everything that lived on Beget); then Owner bootstraps the first credential(s) and turns enforcement on in a separate release GO. Production needs the real deployment, which does not exist on Yoko_PC.

## 9. Acceptance (summary)

Positive: a manager with a credential logs in, sees their name, opens «Люди» and the person card; logout ends every session of that user server-side; «выйти везде» likewise; an Администратор sets or resets a password and the target's old sessions die.
Negative: wrong password → uniform refusal and backoff (same timing for unknown users); disabled user → refusal; expired/tampered/wrong-aud cookie → anonymous; role changed → old session invalid; `crm_user_id` of another user with a valid session → ignored by every reader (proxy rewrite); both mobile and staff cookies → no operator; a Менеджер cannot change roles, add or delete users or write credential fields through any CRUD action, with or without enforcement; the integration-admin session cannot reset an existing credential; a shared admin session is not accepted where an employee is required (G-R2) unless the consumer explicitly admits it.
Regression: integration-admin ceremonies, the Android lane (BR-4, including its operator when `ENFORCE` is on), RCQ1/CC-1, Cash's fail-closed actor rule unchanged; architecture controls PASS.

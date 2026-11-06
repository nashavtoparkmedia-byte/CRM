# Staff Session v1 — a verified browser identity for one CRM employee

**Status: DESIGN — awaiting Identity Access domain-owner agreement and an independent Security DESIGN review. No code of this design has landed.**
Owner context: `identity_access`. Mandate: Orchestrator V7 Contact Identity full conditional delivery mandate, 2026-11-07 (§7: Staff Session is allowed, but requires domain-owner agreement and Security DESIGN review before implementation, and an independent Security review before activation).

## 1. Why

The browser CRM has no verified employee identity:

- `crm_user_id` is an **unsigned** cookie set by `login(targetUserId)` in `gravity-mvp/src/lib/users/user-service.ts`; anyone with browser access picks an identity from `src/data/users.json` (`UserItem { id, firstName, lastName, role: 'Менеджер' | 'Руководитель' | 'Администратор', status, … }`). `canLogin` only prevents a Менеджер from re-picking another id; it proves nothing.
- The only verified server-side principals are the **integration-admin session** (`yoko_integration_admin_session`, HMAC over `{sub, iat, exp}`, 8 h, one shared `ADMIN_USER`/`ADMIN_PASS` credential — a capability for integration ceremonies, not a person) and the **Android mobile session** (`yoko_mobile_session`, HMAC over `{sub, did, iat, exp, sid}`, 12 h, `MOBILE_ACCESS_USER`/`MOBILE_ACCESS_PASS`, `MOBILE_SESSION_REVOCATION_EPOCH`), whose operator BR-4 (#197) makes authoritative for the shell lane only.
- Consumers already wait for an employee principal: the Contact person card (`ContactPersonCardQuery.v1`) and `ContactLookup.v1` answer only the integration-admin principal today (engineering mode, G-R2: a shared admin capability is not an employee's authority); Cash records a manual decision only from `{ kind: 'signed_staff_session', principalId, capabilities }` and sets every other actor aside.

The first real scenario is **one manager** using the person card. The design therefore reuses the proven HMAC-session mechanism and the existing user registry, and adds exactly one thing the CRM lacks: a per-user credential.

## 2. Non-goals

- No multi-tenant / park attribution, no roles beyond the three that exist, no OAuth/SSO, no password-reset flow by e-mail, no new IAM platform.
- No change to Cash authorization rules. Mapping `staff_session` → Cash's `signed_staff_session` actor with capabilities is a **separate Cash-owned decision**; this design only makes such a principal exist.
- No change to the Android lane (BR-4) or to the integration-admin session.
- Does not remove `crm_user_id` in v1; it stops being authority (see §5) and remains a UI selector until the browser lane is closed as a separate decision (R-01).

## 3. The one minimal decision for the Owner

**Credential: an individual password per CRM user, stored as a salted scrypt hash in the existing user registry (`src/data/users.json`, field `passwordHash`), set and reset by an Администратор under a Staff Session or, for bootstrap, by the integration-admin session.**

Rejected: a shared staff password plus a free choice of user — it proves possession of a secret, not the person, so audit (`mergedBy`, `confirmedBy`, Cash actor) would still name an unproven employee. Also rejected: moving users to the `CrmUser` table first — a migration and a second registry for no security gain; the file registry already drives every browser role check.

## 4. Mechanism

Reused verbatim from `integration-admin-credentials.ts` / `mobile-session-credentials.ts`: base64url payload + `HMAC-SHA256` signature, `timingSafeEqual` verification, TTL, revocation epoch, HttpOnly/Secure/SameSite=Lax cookie.

| Element | Value |
|---|---|
| Cookie | `yoko_staff_session` (HttpOnly, Secure, SameSite=Lax, Path=/) |
| Signing key | new C-class secret `STAFF_SESSION_SECRET` (≥ 32 random bytes; **never** `ADMIN_PASS`/`MOBILE_ACCESS_PASS`). Recorded in `docs/SECRETS.md`. |
| Payload | `{ v: 1, sub: userId, role, iat, exp, epoch, uepoch, sid }` — role frozen at issue; `epoch` = global `STAFF_SESSION_REVOCATION_EPOCH`; `uepoch` = the user's `sessionEpoch` from the registry; `sid` = random session instance id (for audit lines). |
| TTL | 12 h (as the mobile session); re-login afterwards. |
| Issue | `POST /login` server action `staffLogin(userId, password)`: registry user must exist, `status === 'Активен'`, `passwordHash` present; `scrypt` verify in constant time; on success issue cookie and **also** write `crm_user_id = userId` (derived, as BR-4 does for the mobile lane); on failure a uniform error, one structured warn line, and a per-user in-memory backoff (5 failures → 60 s). |
| Verify | `getStaffSessionPrincipalV1(): StaffSessionPrincipalV1 \| null` — signature, `exp`, `epoch`, `uepoch` (re-read from registry), user still `Активен`. Any mismatch → `null`, never a partial principal. |
| Principal | `{ kind: 'staff_session', userId, role, sid, issuedAt, expiresAt }` — exported from `identity_access.public.v1`; `capabilities` are derived by consumers from `role` through their own policy, not carried in the cookie. |
| Revocation | logout deletes the cookie; «выйти на всех устройствах» (self or Администратор) increments the user's `sessionEpoch`; `STAFF_SESSION_REVOCATION_EPOCH` invalidates all sessions. Role or status change increments `sessionEpoch`. |
| Password admin | `setStaffPassword(userId, newPassword)` — allowed for the user themself (with current password) or an Администратор under a Staff Session; for bootstrap also under the integration-admin session. Minimum length 10, placeholder rejection as in `rejectsAsPlaceholder`. |
| Audit | one structured line per issue / refuse / logout / epoch bump: `[staff-session] event=… sub=… sid=…`, never the password, never the cookie. |

### Where authority is consumed (v1)

1. `identity_access`: `getStaffSessionPrincipalV1`, `requireStaffSessionV1(roles?)` for pages/actions; `legacyUserServicePortV1.getCurrentUser()` prefers the signed principal's `sub` over the cookie when a session is present (so every existing `getCurrentUser` consumer sees the proven employee without edits), and keeps today's behaviour when none is present — **until** `YOKO_STAFF_SESSION_ENFORCE=on`, after which an anonymous browser request gets `null` from `getCurrentUser` regardless of `crm_user_id`.
2. `contacts`: `identityAccessContactPersonCardAuthorityV1` and the lookup route admit `kind === 'staff_session'` in addition to `integration_admin_session` (phase 2 of the person card). The authority set grows by one named kind in one file; no composition can widen it.
3. Nothing else changes in v1. Cash keeps refusing `crm_user` actors until Cash itself admits `staff_session`.

## 5. Invariants

- A client-held value (`crm_user_id`, a header, a body field) never influences who the principal is. (As BR-4 / CC-1.)
- Password material never leaves the server; hashes never leave the registry; no password or cookie appears in logs or error bodies.
- A disabled user, an expired, forged, replayed-after-epoch or role-stale session is `null` — fail closed, no degraded principal.
- `Менеджер` cannot become anything else by any login path; role is what the registry says at issue time and is revalidated through `uepoch`.
- The legacy `canLogin` escalation matrix is **not** a login path any more once a user has a password: `login(targetUserId)` without a password keeps working only while `YOKO_STAFF_SESSION_ENFORCE` is off, and only for users without `passwordHash` (migration window).

## 6. Threats considered

| Threat | Answer |
|---|---|
| Forged / chosen `crm_user_id` | not authority; `getCurrentUser` derives from the signed principal when present, and ignores the cookie once enforced |
| Stolen cookie | TTL 12 h; per-user and global epoch; HttpOnly/Secure |
| Password guessing | scrypt (N=2^15, r=8, p=1), per-user backoff, uniform error |
| Shared/weak password | individual per user; placeholder rejection; min length |
| Escalation via user management | `setStaffPassword`/role change only under Администратор staff session (or bootstrap integration-admin); bumps `sessionEpoch` |
| CSRF on login/logout actions | same-origin mutation check already used by Identity Access routes (`isExactSameOriginMutationRequest`) |
| Key reuse | dedicated secret; key rotation = epoch bump + new secret (both documented) |
| Not addressed in v1 | TLS termination (edge), device binding, phishing of the password, concurrent-session limits |

## 7. Data and configuration changes

- `src/data/users.json`: optional `passwordHash: { algo: 'scrypt', N, r, p, salt, hash }`, optional `sessionEpoch: number`. No database migration.
- New env: `STAFF_SESSION_SECRET` (C-class), `STAFF_SESSION_REVOCATION_EPOCH` (default `0`), `YOKO_STAFF_SESSION_ENFORCE` (default off). `docs/SECRETS.md` gains the three rows.
- `docs/CRM_ENGINEERING_MAP.md`: §2.8 Identity Access, the Login row, a new invariant (number assigned at landing), R-01 narrowed.

## 8. Delivery and gates

1. **This document** → Identity Access domain-owner agreement (Orchestrator) + independent Security DESIGN review (Security Claude). Changes requested here are applied before any code.
2. **Implementation PR** (identity_access only): credentials module + tests (issue/verify/tamper/expiry/epoch/disabled user), login action + `/login` password step, `getStaffSessionPrincipalV1`, adapter preference, boundary control, Engineering Map, SECRETS.md. Dormant by default (`YOKO_STAFF_SESSION_ENFORCE` off, no user has a password yet). Independent review + hosted CI.
3. **Contacts PR** (one file + checker): admit `staff_session` in the person-card authority and lookup route.
4. **Independent Security review** of the implementation; then Owner sets the first password(s) via bootstrap and turns enforcement on in a separate release GO. Production needs the real deployment, which does not exist on Yoko_PC.

## 9. Acceptance (summary)

Positive: a manager with a password logs in, sees their name, opens «Люди» and the person card; logout ends it; «выйти везде» ends every session of that user.
Negative: wrong password → uniform refusal and backoff; disabled user → refusal; expired/tampered cookie → anonymous; role changed → old session invalid; `crm_user_id` of another user with a valid session → ignored; a shared admin session is not accepted where an employee is required (G-R2) unless the consumer explicitly admits it.
Regression: integration-admin ceremonies, the Android lane (BR-4), RCQ1/CC-1, Cash fail-closed actor rule unchanged; architecture controls PASS.

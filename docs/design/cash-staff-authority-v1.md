# Cash staff authority — the one contract the manager writes need (v1)

**Status: CONTRACT RECORDED, NOT IMPLEMENTED.**
- Producer: Identity Access (`identity_access`).
- Consumer: the Cash referral manager tools (S4, PR #198).

This note records the one thing still missing before a manager can record an invitation, or grant or revoke Cash access, in production. It is not an implementation plan for Fleet, and it brings no schema, migration or new credential.

## Why a contract is needed

`CashAccessEvent` admits a manager event only from `actorKind = 'signed_staff_session'` that also has:
- the kind's capability:
  - `cash.referral.qualify` for `referral_link_recorded`, `referral_link_withdrawn` and `referral_sanctioned`;
  - `cash.access.manage` for `manual_granted`, `manual_cleared`, `manual_denied` and `referral_entitlement_revoked`;
- a session id;
- an authentication time;
- a reason of at least 10 characters.

Three layers enforce this:
- the database CHECK `CashAccessEvent_writer_check` (migrations `20261101120000` and `20261106210000`);
- `cashStaffAuthorityAdmitsV1`, before any write;
- the PostgreSQL proofs in `compensation-referral-ledger.postgres.test.ts`, which also prove that a NULL capability is refused.

S4 therefore has a single integration point, `resolveCashStaffAuthorityV1` in `gravity-mvp/src/app/compensation/referrals/referral-data.ts`. Today it refuses every write with `staff_session_unavailable`. The screens stay readable.

## Decision: reuse the one signed staff session the CRM already has

The Owner's instruction (2026-11-07): authorize the **one existing CRM manager** safely, and build **no** employee-management system.

The CRM already has exactly one staff identity that is verified on the server: Identity Access's **signed integration-admin session**.
- **What it is:** cookie `yoko_integration_admin_session`. It is HMAC-SHA256, compared in constant time, lasts 8 h, and is set `HttpOnly`, `SameSite=Strict`, `Path=/`.
- **Login:** the provisioned `ADMIN_USER` / `ADMIN_PASS`, at `/settings/integrations/access`.
- **Principal:** `getIntegrationAdminPrincipal()` returns a fixed capability principal, `identity-access:integration-admin-session`, only after the session verifies. It never reads `crm_user_id`.
- **Where it is already the authority:** contact merges and their recovery, contact phone and driver-person edits, channel reachability, AI call campaigns, integration credentials, and CC-1's Contact Card read model (`contacts/internal/identity-access-contact-card-authority.ts`, PR #199).

So no new login, credential, cookie lane, staff table, role, `CrmUser` row or permission UI is needed. Giving this principal the two Cash capabilities widens nothing, because it already administers the whole CRM.

The existing manager is whoever holds `ADMIN_USER` / `ADMIN_PASS`. If the Cash manager must ever be a different person from the integration administrator, that is a new identity lane, a v2 of this contract, not configuration of v1.

## The contract

### 1. Identity Access: one new public read
```ts
// gravity-mvp/src/modules/identity-access/public/v1
export async function getIntegrationAdminSessionFactsV1(): Promise<null | {
    principal: IntegrationAdminPrincipalV1   // { id: 'identity-access:integration-admin-session', kind: 'integration_admin_session' }
    sessionId: string                        // non-secret, one per login
    authenticatedAt: Date                    // the signed `iat`
}>
```
- It returns non-null **only** after `verifyIntegrationAdminSession` accepts the cookie.
- It reads nothing else: no `crm_user_id`, header, form field or query parameter.
- It returns null for every refusal: unprovisioned, absent, tampered, expired, credential rotated, or a session without a session instance id (see 2).

### 2. Identity Access: a session instance id in the signed payload
- At issue, the integration-admin payload gains `sid`: 16 random bytes, base64url, minted by the server. Mobile Push v1 added the same field to the mobile session.
- `verifyIntegrationAdminSession` keeps accepting a payload without `sid`, so every current consumer is unaffected. It refuses a malformed `sid`.
- `sessionId` is a sha256 binding of `sid` under its own label, as `mobileSessionBindingIdV1` does.
- It is never a digest of the token. Every other payload field is predictable, so a token digest stored in the ledger would let anyone with the database test `ADMIN_PASS` guesses offline (the BR-4 note in `mobile-session-credentials.ts`).
- A session issued before this change yields `null` facts. The manager signs in once more; nothing else changes.

### 3. The Cash consumer: the capability binding and the wiring (S4, one function)
`resolveCashStaffAuthorityV1` returns `{ ok: true, authority }` only when both hold:
- `getIntegrationAdminSessionFactsV1()` is non-null;
- `managerSession()` still admits the request. It is the UI identity and role gate the board already applies, never the authority.

The authority is:
- `principalId`: `principal.id`;
- `operatorLabel`: `Администратор CRM`;
- `sessionId` and `authenticatedAt`: from the facts;
- `capabilities`: exactly `cash.referral.qualify` and `cash.access.manage`.

The capability binding of the `integration_admin_session` principal kind lives in the Cash consumer. That is how CC-1 binds the same principal to unrestricted Contact Card reads. No capability is read from the browser, the database or a role name.

Everything after that already exists and is tested:
- `cashStaffAuthorityAdmitsV1` and `cashStaffActorV1`;
- the ledger writer CHECK;
- idempotent request ids;
- the history.

### 4. Getting back to the screen after login (optional)
`normalizeIntegrationAdminReturnTo` allows only `/settings…`, `/logs` and `/calls/campaigns…`. Adding the exact path `/compensation/referrals` lets the screen's «Войти» link return there. Without it, the manager navigates back by hand, and nothing is less safe.

## Acceptance (Identity Access, before production)
- **No facts:** a tampered, expired, rotated or unprovisioned session yields none, and so does one without `sid`. Every current integration-admin consumer still accepts a valid session with or without `sid`.
- **`sessionId`:** it is stable for one login and differs between two logins in the same second. It is not derivable from the token.
- **Cookie:** changing `crm_user_id` never changes the facts.
- **Ledger:** with facts, the S4 writes land with `actorKind = signed_staff_session`, `actorId = identity-access:integration-admin-session`, the right capability, `actorSessionId` and `actorAuthenticatedAt`. Without facts they refuse. The database rejects any other actor kind or a missing capability.
- **Review:** a Security review of the two Identity Access changes, as for BR-4.

## Not part of this contract
- A second credential, a staff directory, per-person capabilities, or any change to the mobile lane, nginx or the Cash board's existing principal model.
- Money rules and Telegram bot texts.
- Production activation, which needs Owner GO for each step:
  - migrations `20261101120000` then `20261106210000`;
  - the Cash gate-map regeneration;
  - `YOKO_CASH_ACCESS_LEDGER=on`.

  `ADMIN_USER` / `ADMIN_PASS` are already provisioned in production for the bot administration surface.

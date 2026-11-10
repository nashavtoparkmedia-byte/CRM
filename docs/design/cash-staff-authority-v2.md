# Cash staff authority v2 — Cash as a consumer of Staff Session v1.3

**Status: WRITES WIRED to the published producer (Identity Access #212, in MAIN since 2026-11-10); the Contacts read authority (D2) is NOT PUBLISHED, so reads stay on the integration-admin principal.**
- On 2026-11-08 the Owner approved Staff Session v1.2 (`docs/design/staff-session-v1.md`, PR #200) as the employee identity of the CRM; v1.3 is the version Security passed as the final design and Identity Access built.
- This document replaces v1 (`cash-staff-authority-v1.md`). v1's integration-admin facts (`getIntegrationAdminSessionFactsV1`) will not be built, not even as a step towards v2.
- **Owners:**
  - Identity Access owns authentication, individual passwords, sessions, revocation and the authoritative principal.
  - Contacts owns who may see people.
  - Cash owns only the mapping below and its own write policy.
- Unchanged by this document: the ledger, the event semantics, the migrations `20261101120000` / `20261106210000`, idempotency and every Cash money rule.

## 1. What Cash consumes, and nothing else

| From | What | Used for |
|---|---|---|
| `identity_access.public.v1` | `getStaffSessionPrincipalV1()` → `StaffSessionPrincipalV1 { kind: 'staff_session', userId, role, sid, issuedAt, expiresAt }` or `null` (Staff Session v1.3 §4.2) | the person, the session, the time of login, the role |
| `identity_access.public.v1` | `listUserIdentitiesV1()` (exists) | the history's label for that same `userId`, never identity |
| `contacts.public.v1` | a read-authority answer for the current request (D2 below, not yet published) | whether the screen may show people |

Cash does not read, issue or verify any of the following:
- `crm_user_id`;
- `getCurrentUser()` as authority;
- the integration-admin session as a writer;
- a cookie, a header or a form field.

Cash has no session, credential or middleware of its own.

## 2. The mapping (Cash-owned, in `fleet-operations`)

`cashStaffAuthorityFromStaffSessionV1(principal, directoryEntry, at)` and `resolveCashStaffAuthorityFromSessionV1({ principal, directory, now })`:

| Cash authority field | From | Rule |
|---|---|---|
| `principalId` | `userId` | `staff:<userId>`, the actor name Identity Access itself uses. The `userId` must be exact text of at most 200 characters. |
| `sessionId` | `sid` | `staff_session:` + sha256 of the labelled `sid`. One session gives one name. The ledger never holds the raw id. Only Identity Access's `sid` format binds: 64 lower-case hex digits. |
| `authenticatedAt` | `issuedAt` | The login time. The session must satisfy `issuedAt ≤ now < expiresAt`. |
| `operatorLabel` | the directory entry whose `id` is `userId` | «Имя Фамилия». The entry must be the only one with that id, have the same `role`, and be `Активен`. |
| `capabilities` | `role` | `cash.referral.qualify` and `cash.access.manage`, only for **`Администратор`** (`CASH_STAFF_WRITE_ROLES_V1`). A Менеджер or Руководитель gets nothing until the Owner decides otherwise. |

**Refusals:**
- `staff_session_unavailable`: no session, a session Identity Access refused (forged, expired, revoked by either epoch, disabled user), or a session store or directory that does not answer. In all these cases there is no operator: Cash never falls back to another identity.
- `staff_session_invalid`: another principal kind, a malformed principal, or one outside its lifetime.
- `staff_identity_mismatch`: the directory does not name exactly this principal as Identity Access verified it.
- `staff_role_not_allowed`: a verified employee without the Cash role.

After binding, the existing writer boundary applies unchanged:
- `cashStaffAuthorityForV1` admits a write of each purpose only with its own capability;
- `cashStaffActorV1` builds the `signed_staff_session` actor;
- the database CHECK `CashAccessEvent_writer_check` refuses any other writer.

## 3. The referral screen's guards

Writes are wired (the wiring PR on MAIN `42caee7e`); the read guards follow once D2 is published.

- **Writes (wired).** The body of `resolveCashStaffAuthorityV1()` (`src/app/compensation/referrals/referral-data.ts`) is:
  ```ts
  resolveCashStaffAuthorityFromSessionV1({ principal: getStaffSessionPrincipalV1, directory: listUserIdentitiesV1, now: () => new Date() })
  ```
  - `managerSession()` stays in front only as a gate that narrows; it is never authority.
  - The integration-admin session writes nothing, as today.
- **Reads (search, person card, history; waits for D2).**
  - The actions stop calling `getIntegrationAdminPrincipal()` themselves. They ask Contacts' read authority (D2), because a search result names people and only Contacts decides who may see them.
  - On top of that, a staff session must hold a Cash role (v1: `Администратор`, the same as writes).
  - The integration-admin session keeps reading only as long as Contacts admits it.
- **Page.**
  - `writesAvailable` comes from the write resolver, and the page shows its refusal: a Менеджер reads «Закреплять приглашения и выдавать доступ может только администратор.», and anyone a sign-in would help gets «Войти», which leads to the staff `/login` (wired).
  - `lookupAvailable` comes from the integration-admin principal until D2, then from Contacts' answer; its «Войти» then also leads to `/login`, not to `/settings/integrations/access`.
  - The new refusals have their own texts (wired).
- **C2 source control (wired):** `tools/architecture/check-cash-referral-staff-authority-boundary.mjs`, a boundary control every hosted CI run executes.
  - The four write functions are called only from `actions.ts`, once each, with the authority the server resolved.
  - The actions take that authority only from `resolveCashStaffAuthorityV1()`, which only the actions and the page call.
  - The binder's resolver is called only from `referral-data.ts`, with exactly `getStaffSessionPrincipalV1` (from `identity_access.public.v1`), `listUserIdentitiesV1` (UserIdentity.v1) and the server clock.
  - No `authority` object literal or Cash capability name appears outside the binder and the ledger's own definitions.
  - The actions and the resolver read no cookie, header, `crm_user_id` or current-user record.
  - The binder's write roles stay `['Администратор']` and its `sid` format stays Identity Access's.
  - Each rule also runs against a mutated copy of the tree, and the control fails if a mutant escapes.
- **Governance.** These are source-hash-pinned referral screen paths, so the PR carries an ownership amendment.
- **Nothing else changes.** No migration, ledger or money change is part of the wiring.

## 4. Dependencies

| # | What | Owner | State |
|---|---|---|---|
| D1 | The Staff Session implementation PR (§8.2). It must export `getStaffSessionPrincipalV1` and the type `StaffSessionPrincipalV1` with the fields of section 1. `issuedAt` must be the login time: if a session is ever re-issued, the original login time must stay available. A store it cannot read means no principal (Cash treats a throw and a `null` alike). | Identity Access | **Published:** #212, in MAIN since 2026-11-10 (`1aaf2e48`) |
| D2 | The Contacts PR (§8.3). It admits `staff_session` in `identityAccessContactPersonCardAuthorityV1` and the lookup route, **and** publishes one public read-authority answer that Cash can call for the current request. That answer is evaluated by Contacts' own authority port, the same rule the lookup route and the person card use. Without it Cash would have to copy Contacts' rule, which it may not. | Contacts | Not started |
| D3 | An independent Security review of this consumer boundary: the mapping, then the wiring and C2. | Security | Mapping: PASS (#211). Wiring and C2: requested |
| D4 | The Owner rotates `ADMIN_PASS` and bootstraps the first `Администратор` credential (Staff Session R2). Enforcement goes on in a separate release GO. | Owner | Open |

**Release manifest (from D1, for the Orchestrator):**
- the `identity_access` migration `20261108210000_add_staff_credential` (`StaffCredential` / `StaffCredentialEvent`);
- `STAFF_SESSION_SECRET` (class C), issued in production only after the registry is on persistent storage (C-D3b);
- `STAFF_SESSION_REVOCATION_EPOCH`;
- `YOKO_STAFF_SESSION_ENFORCE`;
- `YOKO_USER_REGISTRY_FILE`, with the one-time `YOKO_USER_REGISTRY_SEED=once`.

Cash adds no migration or secret.

## 5. Tests of the mapping

In `cash-referral-manager.test.ts` and `cash-referral-manager-service.test.ts`:
- **Missing or forged session:** `null`, or a principal of another kind (integration-admin, mobile, a `crm_user_id`-shaped object).
- **Expired, not yet valid, or malformed session:** blank or padded ids, string dates, an invalid clock.
- **Revoked session:** Identity Access answers `null`.
- **Store or directory unavailable.**
- **Changed `crm_user_id`:** another employee's directory entry does not bind; the label always comes from the principal's own id.
- **Directory disagreement:** a demoted or disabled entry, a duplicated id, an empty name.
- **Role:** Менеджер, Руководитель and near-miss spellings get no capability.
- **Capability:** a missing capability is refused (`capability_missing`).
- **Repeats:** a repeated request writes nothing twice, whichever employee repeats it.
- **Attribution:** every event carries `staff:<userId>`, the right capability, the session digest and the login time, and the history shows each employee's own name.

The isolated-PostgreSQL scenario runs the whole manager flow through `resolveCashStaffAuthorityFromSessionV1`, under the database CHECK.

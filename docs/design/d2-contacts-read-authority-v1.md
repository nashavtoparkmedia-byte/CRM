# D2 — personal sign-in for «Люди», the person card and the referral screen

Status: design v1, 2026-11-11. Owner decisions OD-03 (D2, ~01:20), the
Security clarifications (~01:25) and the D2/D2-L split (~01:36), relayed by the
Integration Orchestrator. Contract agreed with Cash (fleet_operations) on
2026-11-11. Production: HOLD.

## 1. What changes for people

- A Менеджер, Руководитель or Администратор who signed in with a personal
  password (Staff Session v1) opens «Люди», a person card and the referral
  screen without the integration-admin login.
- ФИО and phones: all three roles.
- Водительское удостоверение (ВУ): the full number for Администратор only;
  Менеджер and Руководитель see the last four characters.
- All three roles may find a driver by the exact full ВУ. The comparison runs
  on the server, and no response echoes the typed number.
- Referral screen: viewing for all three roles; pinning invitations and
  issuing or revoking standing access stay Администратор-only (unchanged).

## 2. Responsibilities

- Identity Access verifies the employee and the role
  (`getStaffSessionPrincipalV1`, role read from the registry at check time).
- Contacts decides access to a person's data: this note's
  `ContactReadAuthorityQuery.v1`.
- Fleet owns ВУ data and its representation: `maskDriverLicenceV1`, the
  `licence` field of the driver-profile DTO for contacts (required
  `licenceView`), and the exact-ВУ query `findDriverProfilesByExactLicenceV1`.
- Cash consumes those public contracts and copies no rule.

## 3. Contract — `contacts.ContactReadAuthorityQuery.v1`

`resolveContactReadAuthorityV1(): Promise<ContactReadAuthorityV1>`, exported by
`contacts.public.v1`. It is evaluated once per request by the route, page or
server action that reads people data.

```ts
type ContactReadAuthorityV1 =
  | {
      decision: 'allow'
      principal:
        | { kind: 'staff_session'; userId: string; role: 'Администратор' | 'Руководитель' | 'Менеджер' }
        | { kind: 'integration_admin_session'; transitional: true }
      licenceView: 'full' | 'last4'
      policyVersion: 'contacts.read-authority.v1'
    }
  | { decision: 'deny'; reason: 'no_session' | 'staff_session_refused' | 'transitional_admin_read_disabled' }
```

`licenceView` is the single visibility decision. Fleet masks by it, and nobody
derives it from `role` or passes a literal. `role` is there for labels and
audit only.

### Resolution (fail closed, no elevation)

1. A staff session cookie is present: the answer is decided by Staff Session
   alone. A verified principal gives `allow` with `licenceView` = `full` for
   Администратор and `last4` otherwise. A cookie that does not verify gives
   `deny / staff_session_refused`. The integration-admin cookie is not
   consulted at all, so it can never raise a staff user's view.
2. No staff cookie and Staff Session enforcement is on
   (`YOKO_STAFF_SESSION_ENFORCE=on`, the production activation switch): `deny /
   transitional_admin_read_disabled`. This is the single switch that ends the
   transitional path.
3. No staff cookie, enforcement off: a verified integration-admin session gives
   `allow` with `{ kind: 'integration_admin_session', transitional: true }` and
   `licenceView: 'full'` (Owner: the existing admin login keeps its current
   powers until Staff Session is active in production). Otherwise `deny /
   no_session`.

Nothing client-held is an input: `crm_user_id`, headers, bodies and query
parameters never select or change the answer. A credential store or registry
that cannot be read is answered 503 by the request boundary (Staff Session
§4.5, R3) before any route runs; inside a route such a request can only see
`deny`.

The Android mobile session is not a reader for D2 and is left unchanged: a
request that carries it gets no staff principal (Identity Access), and Contacts
does not read the mobile session.

## 4. Surfaces under the answer

| Surface | Reader | Change |
|---|---|---|
| `/contacts` («Люди») | page | `allow` shows the search; `deny` shows sign-in (personal login first). |
| `/api/contacts/lookup` | route | `allow` searches; `deny` → 401. |
| `/contacts/[id]` | `ContactPersonCardQuery.v1` authority | admits `staff_session` beside the transitional admin; the confirmed answer carries `licenceView` for the composition. |
| person card composition | platform-shell | passes `licenceView` to Fleet's DTO; renders `licence` as Fleet returns it. |
| exact-ВУ search in «Люди» | `/api/contacts/lookup` (licence mode) | Fleet `findDriverProfilesByExactLicenceV1({ licence, licenceView })`; Contact ids and masked numbers only; never the typed value. |
| referral screen | Cash actions | the same answer; `licenceView` handed to Fleet from it (Cash C2 control). |

Out of D2 and unchanged:
- Contacts writes (merge, phone edits, identity and driver-person changes) stay
  on the integration-admin session.
- The legacy readers named by the D2-L inventory (monitoring, `/drivers`,
  Messages evidence and contact panel, tasks and Excel export, bot import) are
  the separate P1 «D2-L» right after D2.

## 5. Controls and proofs

- `check-contact-read-authority-boundary`:
  - the resolver reads only the Identity Access public functions above;
  - no `cookies()`, `headers()` or `crm_user_id` reads in Contacts' authority;
  - the person-card authority admits exactly `staff_session` and the
    transitional `integration_admin_session`;
  - every caller of `searchContactsV1` and every Contacts people-data route or
    page evaluates `resolveContactReadAuthorityV1` first;
  - `licenceView` reaching Fleet comes from the answer, never a literal.
- A ВУ-reader inventory (every non-test reader of `Driver.licenseNumber` and
  its copies) with a disposition per reader: masked, Администратор-only, or
  D2-L with a named owner. The checker fails on a new unlisted reader.
- Negatives:
  - only `crm_user_id`;
  - a forged, expired or foreign staff cookie;
  - a disabled user;
  - a role downgraded mid-session;
  - staff cookie plus admin cookie (Менеджер stays `last4`);
  - enforcement on (admin read off);
  - Менеджер gets last-4 on every route, page and action;
  - exact-ВУ search returns no echo;
  - no full ВУ in logs or error text.
- Mutants:
  - the mask removed;
  - the role or view taken from `crm_user_id`;
  - the admin cookie consulted with a staff cookie present;
  - the enforcement switch ignored.

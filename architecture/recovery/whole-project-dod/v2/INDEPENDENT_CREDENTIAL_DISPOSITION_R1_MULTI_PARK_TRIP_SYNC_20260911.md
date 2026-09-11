# Independent source-flow credential disposition — YOKO CRM, one production secret-read site

Reviewer: independent reviewer, Claude Code session `6915801a-227c-47af-be06-1e8ec3a05c61`, 2026-09-11.
Repository: `github.com:nashavtoparkmedia-byte/CRM`, worktree `/opt/codex-work/crm-r1-cron-integration-20260911`.
Branch `claude/r1-cron-integration-20260911`, commit `1f49250a4fdbe68478169770fbbb9875c5fa47d3`, tracked worktree clean.
Target: `gravity-mvp/src/lib/YandexFleetService.ts`, line 152, column 35, `prisma.apiConnection.findMany`, READ, `ApiConnection`.
Whole file read at SHA-256 `182275f73d9a7d817fd79e3dfbadf3f575700fb2357a579eb8b9dbd5e3af5f35` (299 lines).

This disposition is mine. I did not adopt the implementing thread's reasoning, and I re-measured every figure my
conclusion rests on. No repository file was modified.

## 1. Disposition

**`OWNER_INTERNAL_VALID`** — resolved semantics `OWNER_INTERNAL_SECRET_READ_NO_PUBLIC_FLOW`.

The classification turns on what the reviewed source does with the secret, and this file confines it. The four
columns the call projects are consumed at exactly two places, the `X-Client-ID` and `X-Api-Key` request headers
inside the module-private `fetchParkOrders`. No exported symbol returns a credential: the file exports two result
types carrying seven non-credential fields, plus a class whose only public member is `syncTrips`. The credential
type `ParkConnection` is module-private. All eight `console.*` calls interpolate park identifiers and counters only.
The credential value crosses no public module contract, which is exactly what the `fleet_operations` manifest
requires of this model ("Values stay inside the owning adapter and never cross a public contract").

`APPROVED_RUNTIME_PROVIDER_CAPABILITY` is not merely expensive here, it is factually wrong. Its definition requires
the secret to be carried "through independently reviewed non-public consumers or projectors", and the verifier
requires a `runtime_boundary_review_id` whose consumer graph is derived and compared. This site has no
credential-returning export, so there is no consumer edge to enumerate. The absence of a graph is the evidence that
the secret does not cross a boundary, not a gap to be papered over.

## 2. The record

Replaces `production-secret-read-043`, which is removed. Total stays 74.

```json
{
  "review_id": "production-secret-read-075",
  "review_key": "gravity-mvp/src/lib/YandexFleetService.ts|152|35|findMany|READ|ApiConnection|6c4bfaff2acc67923c324484af8af540df2845d43f34ecb0798330af02bab1da|182275f73d9a7d817fd79e3dfbadf3f575700fb2357a579eb8b9dbd5e3af5f35",
  "file": "gravity-mvp/src/lib/YandexFleetService.ts",
  "line": 152,
  "column": 35,
  "method": "findMany",
  "access": "READ",
  "entity": "ApiConnection",
  "site_signature": "6c4bfaff2acc67923c324484af8af540df2845d43f34ecb0798330af02bab1da",
  "credential_owner": "fleet_operations",
  "classification": "OWNER_INTERNAL_VALID",
  "resolved_semantics": "OWNER_INTERNAL_SECRET_READ_NO_PUBLIC_FLOW",
  "invocation_boundary": "APPLICATION_RUNTIME",
  "operator_only": false,
  "public_flow": false,
  "capability_id": "credential.owner.fleet_operations.application-runtime.v1",
  "approved_architecture_path": "owner-runtime/fleet_operations",
  "review_basis": "Execute the fleet_operations owner runtime trip-sync capability: every ApiConnection credential column this call loads is consumed only as an outbound Yandex Fleet request header inside this module, and no exported symbol, returned value, log line, persisted column or browser-facing string that this file produces carries a credential field.",
  "evidence": [
    "whole-file-review-at-sha256:182275f73d9a7d817fd79e3dfbadf3f575700fb2357a579eb8b9dbd5e3af5f35 — all 299 lines read at commit 1f49250a4fdbe68478169770fbbb9875c5fa47d3, not only the changed statement",
    "exact-source-location-remeasured:gravity-mvp/src/lib/YandexFleetService.ts:152:35 findMany READ ApiConnection, site signature 6c4bfaff2acc67923c324484af8af540df2845d43f34ecb0798330af02bab1da, reproduced from a fresh whole-repository credential inventory that returns exactly one row for this file",
    "credential-field-references-enumerated:4 — the module-private ParkConnection type at line 55, the X-Client-ID header at line 107, the X-Api-Key header at line 108, and the four-column projection at line 154; the headers are the sole consuming use",
    "no-credential-in-any-emitted-value: YandexTripSyncResultV1 carries seven non-credential fields, all eight console calls in this file interpolate only park identifiers and counters, the all-parks-failed throw at line 285 concatenates park identifiers and messages, and neither exported type nor the class surface exposes clid or apiKey",
    "owner-context-match-at-the-current-location:fleet_operations=fleet_operations — the file is listed in the fleet_operations manifest owned_paths and internal_surface, ApiConnection is an owned credential model, and the credential value crosses no public module contract",
    "distinguished-from-production-secret-read-053-and-054: those sites sit in a public/v1 module that returns credential objects to four enumerated consumers in other files, so they required a runtime boundary consumer graph; this site has no credential-returning export and therefore no such graph to enumerate",
    "residual-provider-text-channel-recorded-as-a-separate-finding: line 118 copies the upstream error body verbatim into a message that reaches SyncStatus.errorMessage and an ungated /drivers render, and a malformed stored credential can be echoed by the header-validation TypeError; this disposition covers the credential read only and authorizes neither channel"
  ],
  "review_scope": {
    "source_sha256": "182275f73d9a7d817fd79e3dfbadf3f575700fb2357a579eb8b9dbd5e3af5f35",
    "credential_exposure": "SECRET_READ",
    "public_secret_risk": false,
    "context_classification": "OWNER_DIRECT_DB_ACCESS",
    "source_context": "fleet_operations",
    "lifecycle": "APPLICATION_RUNTIME",
    "disposition": null,
    "production_capability": "POSSIBLE",
    "functional_owner": null,
    "registry_classified": false
  }
}
```

## 3. Aggregates and summary counters

Recomputed together from a fresh whole-repository inventory at this commit, not patched.

| Field | Value |
| --- | --- |
| `current_exact_review.access_denominator` | 74 |
| `current_exact_review.unique_site_signature_denominator` | 63 |
| `current_exact_review.sorted_review_keys_sha256` | `e020433b2a5459f1b85e0f851dbe05891adaa45f11bcea24eb74228473f00a04` |

Summary block, unchanged from the accepted artifact because the replacement keeps the same classification:

```
total                                        74
owner_internal_valid                         39
approved_provider_capability                  9
redacted_safe                                18
approved_operator_credential_diagnostic       3
approved_credential_import_capability          1
approved_runtime_provider_capability           4
application_runtime                          43
active_operational_script                    31
unresolved                                    0
unknown                                       0
public_secret_risk_records                    0
foreign_direct_secret_reads                   0
unreviewed_secret_bearing_runtime_capabilities 0
```

Per-classification counts sum to 74, and 43 + 31 = 74 matches the measured lifecycle split.

## 4. The six sub-questions

**1. Cardinality or downstream semantics?** Cardinality only, for the secret. One row becomes all rows, so a single
call holds every park's key in memory instead of one, and `findFirst … desc` becomes a deterministic
`findMany … asc`. No new sink, no new consumer, no new boundary crossing. What does widen is the *error-text*
channel: the all-parks-failed throw at line 285 concatenates every park's message, where before only one park's
message could appear. That is an operational-status amplification, not a credential one.

**2. Do the sinks constitute a public secret-bearing response?** No, on the evidence, and the question is narrower
than it was when revision 7 of the packet was written. Both `'use server'` triggers now call
`requireIntegrationAdminAccess()` as their first statement, and that guard is fail-closed when unconfigured: a
missing, short or placeholder `ADMIN_USER`/`ADMIN_PASS` makes `getIntegrationAdminCredentialConfig` return null and
every session verification false. The cron route denies before any data access.

What the remaining ungated path carries is not a secret. `getYandexSyncStatus` is an ungated `'use server'` export
that returns `SyncStatus.errorMessage` verbatim; `/drivers` has no page guard and there is no middleware, so an
unauthenticated viewer reaches it through `YandexSyncControl`, which renders the column into a `title` attribute.
The content of that column is park names, park identifiers and third-party error text. Park identifiers are not
credential fields under the policy for this entity, whose only sensitive field is `apiKey`. So the response is
reachable but not secret-bearing on any measurement available here.

Two residual mechanisms keep that answer conditional rather than absolute, and I record them as findings in
section 5 rather than forcing them into a field.

**3. Is the failure and truncation reporting a secret-bearing runtime flow?** No. The reported entries are
`{ parkId, name, message }`; none is a credential field. `secret_bearing_runtime_flow` is in any case a field of the
provider classification, which does not apply. It is non-secret operational status whose `message` is unbounded
third-party text.

**4. Does the explicit four-column select matter?** Not to the disposition. `apiKey` is still projected, so
`credential_exposure` stays `SECRET_READ` and `exposed_sensitive_field_names` stays `["apiKey"]`. Naming four
columns instead of reading the whole row is a narrowing improvement with no disposition consequence.

**5. Distinguishable from `production-secret-read-054`?** Yes, on one measured ground. Record 054 covers a call in
`modules/fleet-operations/public/v1/yandex-connection-capability.ts`, a public module contract whose two exported
functions hand credential objects to four consumers in three other files; that is why it needed a runtime boundary
review and declares `public_flow: true` with `external_public_secret_response: false`. Identical call shape is not
the test. The test is whether the secret leaves the reading module, and here it does not. Same method, same ordering,
same projection, different boundary.

**6. Does the source-only gate matter?** Not to the disposition. The artifact binds each disposition to the SHA-256
of tracked source, so the disposition is a statement about these bytes. It matters to production risk, and there the
direction is unfavourable: the deployed build predates the gate, `CRON_SECRET` is unset, and the in-process hourly
timer runs the sync without passing through any HTTP gate at all. That belongs in the deployment decision, not in
this record.

## 5. Findings this disposition does not cover

1. **Ungated read of persisted error state.** `getYandexSyncStatus` in `gravity-mvp/src/app/drivers/segmentation-actions.ts:84`
   is a `'use server'` export with no guard, returning `SyncStatus.errorMessage` verbatim. `/drivers` has no page
   guard and the repository has no middleware. An unauthenticated viewer therefore reads whatever text the last
   authorized run stored. The write side is gated; the read side is not.
2. **Unbounded third-party text copied verbatim.** Line 118 builds its message from `await res.text()` with no
   truncation, parsing or allow-listing, and that text reaches the persisted column in finding 1. Nothing available
   in this environment can bound what the provider writes into an error body, and a third-party sample shows the
   provider's `message` field echoing caller-submitted request material. Under a conservative trust boundary this
   should be bounded at the copy site, not at the classification.
3. **A malformed stored credential can be echoed, and I measured the mechanism.** On the pinned Node v20.20.2,
   `Headers.append` throws a `TypeError` whose message embeds the offending header value verbatim, and that error is
   thrown before any network I/O, is not wrapped by `yandexFetch`, and lands in the `catch` at line 215 whose
   `.message` is propagated. Trigger: an interior CR or LF, or a NUL anywhere. I refined the packet's claim here:
   leading and trailing CR/LF are normalized away and do not throw, so the precondition is narrower than stated but
   real. `addApiConnection` validates only non-emptiness and the column is a bare `String`, so nothing in the write
   path prevents it.
4. **No committed regression test for the `sync-trips` gate.** `sync-scraper` has `route.test.ts` and it is in
   `test:security-boundaries`; `sync-trips` has no test file. Its gate is pinned by
   `check-operations-scheduled-fleet-cron-boundary.mjs`, which I ran green, so the contract is enforced, but the
   runtime proof cited in the packet came from an uncommitted harness.
5. **Seven of nine cron routes remain ungated**, which the boundary checker pins deliberately as tracked elsewhere.

## 6. What I re-measured, and what I could not

Reproduced independently and matching the packet: the file hash; line, column, method, signature and the single
inventory row for this file; the 74/63 denominators and the digest `e020433b…`; the one-key-out, one-key-in
difference against the accepted set; the verifier failing at exactly one assertion, the stale exact-key digest at
line 829; the cron boundary checker green with both routes classified fail-closed and seven tracked separately;
fleet_operations ownership of the file and of `ApiConnection`; the target file byte-identical to the R1 checkpoint.

Corrections to the packet, none of which change the target site:

- The merge took `a9733e09`, not `c06af51026c5aeaab8006a6c9694077e4a360922`. That commit is **not** an ancestor of
  HEAD. All three security source commits (`c39cb3ce`, `c470fbe2`, `e9532310`) are ancestors, so the security content
  is present; the packet's commit id is one commit off.
- The merge changed **six** files under `gravity-mvp/src`, not two: both cron routes, the scraper route test,
  `segmentation-actions.ts` and its test, and `integration-admin-boundary-source.test.ts`.
- The console-call line numbers in packet section 8 are stale. The correct lines are 24, 117, 127, 131, 169, 217, 278
  and 288. None carries a credential.
- The header-validation trigger characters are interior CR/LF or NUL anywhere, not any CR/LF/NUL.

Not established, and not claimed: whether any device upstream of the VPS filters `/api/*`; whether the gated route
and the guarded actions behave identically under a real Next.js server rather than module-level reasoning; whether
this candidate will be deployed; and whether a Yandex Fleet error body is credential-free, which no client-side
measurement can settle. The production-database and production-runtime figures in the packet are not reproducible
from the repository and I did not rely on them.

I note the disclosed biases and did not rely on either carrier. The R1 commit message asserts this conclusion, and
my agreement with it is coincidence of evidence, not deference: the grounds above are the module's export surface
and the manifest's own credential policy, neither of which the commit message cites.

## 7. Governance matters for the owner

- Replacing a record whose `site_signature` changed is not defined anywhere in the artifact or its checkers as either
  a rebind or a re-disposition. I treated it as a fresh disposition, because the artifact's `source_byte_binding`
  contract says a byte change requires one.
- Nothing correlates a record's evidence strings with its own file, line, column or signature, so record 043's now-false
  evidence passed the machine silently for as long as it stood. My strings are written to be re-checkable by hand.
- The declared `review_authority` `INDEPENDENT_SOURCE_FLOW_CREDENTIAL_REVIEW_20260813` appears only in the artifact
  that declares it, and no tool can write the artifact. Who holds that authority remains an owner question.

# Independent source-flow credential review — YOKO CRM, one production secret-read site

You are being commissioned as the **independent reviewer** for a single production
secret-read disposition in the YOKO CRM repository. You are not the implementing
agent, you did not write the code under review, and your decision is the authority
for this disposition. Do not delegate it.

## What to review

Repository: `github.com:nashavtoparkmedia-byte/CRM`
Branch: `claude/r1-cron-integration-20260911` (a temporary integration branch)
Commit: `1f49250a4fdbe68478169770fbbb9875c5fa47d3` (pushed and fetchable from `origin`)

This commit merges the R1 multi-park trip-sync work (`59c9db11`) with the completed
cron-security work (`c06af510`), which itself sits on current `origin/main`. The
integration exists so you review one tree that carries both. The historical R1
checkpoint is unchanged on its own branch.

Target site: `gravity-mvp/src/lib/YandexFleetService.ts`, line 152, column 35,
`prisma.apiConnection.findMany`, access READ, entity `ApiConnection`.

The accepted disposition registry is
`architecture/recovery/whole-project-dod/v2/PRODUCTION_SECRET_READ_DISPOSITION_REVIEW_20260813.json`.
Record `production-secret-read-043` covers the predecessor of this site and is now
stale, because the file's bytes and the call expression both changed.

The artifact's own contract governs the scope of your review:

> Each accepted disposition is bound to the exact SHA-256 of the tracked source
> file whose whole-file downstream semantics were independently reviewed. A byte
> change requires a fresh independent disposition; inventory discovery alone does
> not authorize it.

So **read the whole file** at SHA-256
`182275f73d9a7d817fd79e3dfbadf3f575700fb2357a579eb8b9dbd5e3af5f35`, not only the
changed statement.

## The evidence packet

An evidence packet has been prepared for you. It contains measurements, not a
recommendation.

Path: `CREDENTIAL_REVIEW_PACKET.md`
SHA-256: `aff307f7211557b5fb9c47e93c3f78a41106b8559daf9c450db7a6dc368a89bf`

Treat it as a starting point and a checklist, not as testimony. Every figure in it
is reproducible; section 15 gives the commands. Re-measure whatever your decision
rests on.

## What you must decide

Reading the complete file at that hash, what is the correct disposition of the
`ApiConnection` secret read at line 152, and what is the review basis for it?

Six sub-questions are listed in packet section 16. The three that carry the most
weight:

- **Every externally triggerable path into this read is now gated, and that does
  not close the question.** `GET /api/cron/sync-trips` carries a fail-closed
  `CRON_SECRET` bearer check, measured at runtime as 401 with the capability never
  invoked, and both `'use server'` actions in
  `gravity-mvp/src/app/drivers/segmentation-actions.ts` now call
  `requireIntegrationAdminAccess()` first. What remains ungated is the **read** of
  state a previous authorized run persisted: `getYandexSyncStatus` returns
  `SyncStatus.errorMessage` without a gate, on a page served without a session.
  Packet sections 8 and 11 have the evidence.
- **The gate is source-only.** Production runs a build from 2026-09-01 on a
  different branch, with no gate at all, and `CRON_SECRET` is unset everywhere.
- **Upstream error text cannot be proven credential-free.** The provider's error
  body is copied verbatim into sinks that include a persisted database column and a
  browser payload, and no measurement available in this environment can bound what
  the provider puts in an error body. Packet section 12.

Decide these on the evidence and your own reading, under whatever trust boundary
you judge correct.

## Explicit warnings about bias in the material

1. **Branch history pre-states a conclusion.** The R1 commit message
   (`4e876d37`) asserts that the read "stays an owner-internal Prisma read" and
   that `fleet_operations` owns the model. A source comment saying the same thing
   existed and was removed in `3068590c` precisely because it pre-stated your
   finding. **Neither is evidence.** Both are the implementer's opinion, recorded
   before any independent review existed.
2. **The packet's author wrote the code.** The packet discloses this.
3. **The predecessor record's classification is disclosed in packet section 7.**
   It is a prior reviewer's finding about different bytes. You are not being asked
   to confirm it, and it does not carry forward.

## What to produce

A record replacing `production-secret-read-043`. Packet section 9 gives the
candidate with every measurement-fixed field filled in and every judgement field
left blank. The blank fields are yours: `classification` (one of the six in the
artifact's vocabulary), `resolved_semantics`, `invocation_boundary`,
`operator_only`, `public_flow`, `capability_id`, `approved_architecture_path`,
`review_basis`, `evidence` and `review_id`.

Three machine constraints on the choice, and two traps in the free text, are set
out in packet sections 9 and 16. Note in particular that choosing
`APPROVED_RUNTIME_PROVIDER_CAPABILITY` would require editing two hardcoded checker
denominators, which is an owner decision rather than something you can resolve
inside the artifact. If your judgement is that **no** classification in the
vocabulary fits, say so; that is a finding about the change, not a field to force.

Also recompute the three aggregates and the summary counters exactly as packet
section 9 specifies.

Write your own `evidence` strings describing what **you** measured. The
predecessor record's evidence strings hardcode the old location and signature and
are now false; nothing in the verifier detects that, so do not copy them.

## Independence evidence to capture

A location has been reserved for your evidence:
`architecture/recovery/whole-project-dod/v2/EXTERNAL_REREVIEW_REMEDIATION_LEDGER.json`,
top-level key `external_review_r1_multi_park_trip_sync_20260911`, currently seven
null fields. Emit or preserve, and report back:

- your task or session identifier
- the path of this prompt artifact and its SHA-256
- the path of your session transcript, if your tool produces one, and its SHA-256
- your final output, its timestamp, and its SHA-256 without an added trailing newline

## Out of scope

Do not change source code. Do not change the cron routes or the server actions.
Do not merge, deploy, push, or run a production sync or backfill. Do not write the
disposition artifact yourself unless the commissioning owner explicitly asks you
to; your decision plus the record fields are the deliverable.

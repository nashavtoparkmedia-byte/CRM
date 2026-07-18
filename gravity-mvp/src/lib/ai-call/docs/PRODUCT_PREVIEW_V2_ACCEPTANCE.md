# AI Calls Product Preview V2 — acceptance snapshot

## Implemented

- Direct DEV route `/ai-calls` with projects, scenario editor, mock run, results,
  and provider settings.
- Three project types: lead qualification, churn recovery, and quality survey.
- Read-only Contact resolution preview with invalid, not found, matched, and
  ambiguous states.
- Strict runtime-validated AI decision contract.
- Deterministic application event key and retry/parallel protection.
- Typed human handoff preview without live SIP transfer.
- Isolated audio bridge lifecycle contract for reconnect, timeout, and
  backpressure.

## Verified

- AI Calls tests: 124 passed, 0 failed.
- Audio Bridge tests: 180 passed, 0 failed.
- Scoped TypeScript: passed.
- Changed-files ESLint: passed.
- Production-equivalent application build: passed.
- Protected-files guard: passed.
- Added-line secret scan: 0 matches.
- `git diff --check`: passed.
- Browser: `/ai-calls` passed at desktop and 390 px width.
- Browser flow: projects → mock call → result passed.
- Browser console: 0 warnings and 0 errors from the page.

## Isolation

No production deploy, restart, migration, database write, real call, provider
request, SIP transfer, FreeSWITCH change, shared navigation change, or Messages
merge was performed.

## Remaining coordinated integration

- Persist projects, scenarios, and results through an approved AI-specific data
  model.
- Connect canonical Contact resolution and Contact history through the accepted
  shared contract.
- Connect production providers and live telephony.
- Add a database unique constraint for final cross-process event idempotency.
- Integrate shared navigation only after owner approval.

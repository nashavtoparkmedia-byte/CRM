# Broader MAX 123/130 versus 124/130

The retained raw side-by-side evidence is:

- exact Stage 8A: `/tmp/max-stage8b1r-stage8a-broader-max.log`, 130 tests, 124 pass, 6 fail;
- exact Stage 8B1: `/tmp/max-stage8b1r-stage8b1-broader-max.log`, 130 tests, 124 pass, 6 fail;
- Stage 8B1R after dependency remediation: `/tmp/max-stage8b1r-scraper-remediation.log`, 130 tests, 124 pass, 6 fail;
- Stage 8B1R after the Playwright update: `/tmp/max-stage8b1r-playwright-remediation.log`, 130 tests, 124 pass, 6 fail.

All four retained logs contain the same six failures: composite fallback, structured media fields, raw-WS redaction, non-mutating trace snapshot, new-chat reachability UI, and contact-profile reachability. The historically accepted broader MAX baseline is 123/130, or seven failures. No retained Stage 8B1R raw log reproduces that seventh failure, so this package does not claim a repeated-run count or fabricate a 123/130 execution.

The historically variable seventh test is:

`MAX repeated inbound text is keyed by provider ID and replay is deduplicated`

The test constructs `new MessageSync({ dedupPath })`, but the implementation constructor accepts no argument and always loads and writes the ignored shared file `max-web-scraper/last_seen_dedupe.json`. A process that inherits matching persisted IDs can therefore fail the first `isDuplicate(first) === false` assertion, while another state can pass. Stage 8A, Stage 8B1 and Stage 8B1R contain the same test and `MessageSync` behavior. This is a plausible stateful test-isolation mechanism for the historical 123/130 versus retained 124/130 difference, not evidence that the seventh failure occurred in the retained runs.

Additional retained Stage 8B1R evidence is:

- `/tmp/max-stage8b1r-final-gateway-real.log`: gateway typecheck passed and unit tests passed 197/197; its real-PostgreSQL attempt was rejected by the disposable-database naming guard before test execution;
- `/tmp/max-stage8b1r-final-real-pg.log`: the corrected disposable real-PostgreSQL suite passed 124/124;
- the current Stage 8B1R verification ran the established four-file targeted Gravity pack at 15/15 PASS;
- the same verification added `max-message-pipeline-contract.test.ts` for the broader Gravity pack and reproduced 17/20 with the same three accepted source-contract failures: outbound field shape, inbound attachment/reply separation, and invalid UTF-8 diagnostics.

Accepted baseline debt therefore remains seven MAX failures and three Gravity failures. The retained 124/130 observations show no new broader MAX failure from Stage 8B1R, but they do not reduce or rewrite the accepted historical debt. The Stage 8B1R Gravity differential exactly matches its accepted 17/20 baseline.

## Executable restart-recovery remediation

The exact-image outage/restart proof found that a fully compacted spool retained ACK watermark `25` but recovered an empty segment set with next sequence `1`. A new record at sequence `1` was then correctly filtered as already acknowledged and could not drain. Stage 8B1R now derives the next sequence as `max(highest segment sequence, durable ACK watermark) + 1`. The producer regression requires the first post-restart record to be pending at sequence `26`; the executable proof independently recreates the scraper and gateway around the outage and requires that record to ACK before readiness returns to 200.

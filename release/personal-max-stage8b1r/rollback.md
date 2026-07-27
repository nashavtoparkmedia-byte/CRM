# Rollback plan

Rollback is control-plane only and preserves evidence:

1. Disable the exact account in `MAX_PERSONAL_LIVE_CAPTURE_ENABLED`.
2. Stop the capture drain cleanly when possible.
3. Preserve the host spool and its 0700/0600 ownership; do not delete unacknowledged segments.
4. Keep the legacy max-web-scraper and its Chromium profile/session owner running.
5. Stop/remove only the browserless gateway when safe.
6. Do not reverse the additive migration or drop raw journal data/indexes.
7. Retain image digests, SBOMs, scan reports, health snapshots and migration/backup evidence.

Triggers include any lost-before-spool count, envelope collision, cross-account difference, authentication anomaly, critical spool state, migration/readiness failure, new semantic critical regression, second browser owner, sender/provider activation or digest mismatch. No automatic rollback may send a provider action or mutate CRM projections.

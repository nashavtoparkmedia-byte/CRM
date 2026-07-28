# Rollback and freeze triggers

Global freeze triggers include malformed/checksum-unbound reports, migration or dormant-rollout evidence mismatch, current migration/schema/append-only drift, actual gateway image/source mismatch, container replacement during the window, runtime topology/security drift, unhealthy or restarting gateway, missing required metrics, database pressure, disk below reserve, and unproven sender/projection/provider inactivity.

Scraper image/health/profile/browser/listener gates are target-specific: they apply to `default-off`, `one-account`, and `ab`, but not to `dormant`. They also require the scraper to predate the observation window. Active targets additionally freeze on missing bound external evidence, unknown/zero physical-frame evidence, untrusted spool-limit evidence, missing recovery evidence, account-identity mismatch, inconsistent capture/spool facts, old spool backlog, stopped journal/comparison growth, any critical semantic diff/regression, route-identity mismatch, wrong-account, accidental duplicate envelope, route conflict, lost-before-spool, drain failure, or spool at/above 70% of its trusted bound. Default-off freezes on missing bound external evidence, any capture/journal/spool side effect, or unknown existing-flow health.

Missing Prometheus samples are represented as JSON `null`, set `metricsComplete=false`, and freeze. They are never converted to zero. A script failure produces an explicit sanitized failure handoff with phase, classification, line, and exit code.

Contradictory report facts fail closed before handoff: mismatched windows or totals, false image/config/lifecycle claims, release mismatch, disk-reserve lies, action/rollback mutation, non-exact safety, altered migration/dormant evidence, or inconsistent final evaluation cannot produce `ACCEPT`.

The evaluator never runs rollback. It emits the exact triggers and freezes further enablement. Production rollback always requires separate authorization and never drops additive schema or deletes journal evidence.

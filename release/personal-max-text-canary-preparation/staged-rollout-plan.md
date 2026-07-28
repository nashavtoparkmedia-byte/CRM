# Staged rollout plan

Every step is a separate architect gate. This document contains sequence only, not authorization or executable rollout commands.

1. Accept successful isolated proof after independent provenance review.
2. Authorize and execute the exact-eight production migration under its existing package gate.
3. Authorize the dormant gateway rollout with every runtime feature still off.
4. Complete dormant observation and accept its sanitized evaluator output.
5. Separately authorize the checksum-bound scraper runtime metadata probe.
6. Accept metadata only after identity, ownership, one-browser/listener, immutability, and recreation facts pass review.
7. Build future immutable gateway and scraper images from an accepted source commit; both are currently `NOT_BUILT`.
8. Roll out the future scraper image default-off only after profile UID/recreation evidence is accepted.
9. Observe the default-off scraper and prove no browser, listener, profile, route, or message regression.
10. Authorize the additive SessionOwner and shadow-plan migrations for the next release; neither is part of exact-eight.
11. Enable outbound shadow planning for exactly one account while physical sender remains disabled.
12. Observe owner/shadow metrics, FIFO, refusals, account isolation, and critical regressions.
13. Validate the synthetic sender in an isolated production-like environment with durable replay/idempotency implementations.
14. Authorize Contact A text-only canary under exact account and conversation allowlists.
15. Authorize Contact A+B only after Contact A passes every stop gate.
16. Expand to a bounded broader canary only after an explicit architecture decision.
17. Decide cutover or rollback from accepted sanitized evidence; no automatic cutover exists.

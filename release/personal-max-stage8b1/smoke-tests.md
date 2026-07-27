# Stage 8B2 smoke tests

1. Verify exact image digests, commit provenance, backup artifacts and spool ownership.
2. Start gateway with all flags empty; expect `/ready` state `dormant-ready`, no DB session and capture endpoint `503 INGRESS_DORMANT`.
3. Rehearse migration command and verify all 53 migrations, then apply only with owner approval.
4. Enable raw journal, normalizer, comparison and capture for one approved existing account; never use wildcard or boolean values.
5. Verify one scraper/profile owner, zero gateway browser dependencies, zero sender/provider activity and no nginx/host ingress.
6. Inject only the approved non-provider synthetic health probe; verify authenticated ACK, journal row, normalization, comparison and readiness.
7. Observe spool, loss, collision, wrong-account and critical-regression gates for the approved window.
8. Trigger rollback immediately on any documented condition.

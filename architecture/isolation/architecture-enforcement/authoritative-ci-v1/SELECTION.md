# Authoritative architecture CI v1

This source-only slice replaces the partial workflow with one fail-closed runner for the current architecture control plane. The accepted implementation identity is commit `21b17f08607905a24f4a9e882091d5c1cab94160`, tree `756bed74651a40b0bb3f63eddaa2dcc7420b3393`.

The pull-request and main-push workflow now executes 35 controls: 31 targeted policy, negative, boundary, critic, TypeScript and security controls plus one fresh bounded whole-repository write scan, its verifier, one fresh credential inventory, and its verifier. The write scan is limited to four workers with a 120-second per-worker deadline and structured progress. The job itself is bounded to 20 minutes.

The cumulative boundary inventory is explicit rather than filename-selective: 118 checker files are classified, 112 are active, and six historical checkers are superseded only through named active successors and recorded rationale. Missing checkers, missing successors, duplicate lifecycle records, and an unrelated capability added to a protected writer fail their respective negative gates.

Changed-path enforcement uses the pull-request base SHA or push-before SHA, retains deletions, maps owners and inverse consumers, and fails on an unclassified production path. Invalid all-zero event identities resolve deterministically to the first parent; an unresolvable change-set base fails closed. TypeScript is capped at the accepted 30 inherited diagnostics and rejects any diagnostic on a changed path.

Fresh inventory verification rejects incomplete execution, worker failures or timeouts, parse findings, foreign writes, unclassified operational surfaces, new ambiguity signatures, sensitive-field registry drift, new public credential risk, new cross-domain secret reads, and any unreviewed shrink in the tracked-surface/write/credential denominators.

Local acceptance ran `node tools/architecture/run-authoritative-ci.mjs --skip-full-scans` and passed 31/31 selected controls, including 112/112 active boundary controls, the independent source critic, Gravity 34/34 and tg-bot 15/15. The full repository inventories were intentionally not rerun locally: this batch changes only CI/control-plane source and does not materially change write or credential architecture. CI is configured to produce fresh bounded inventories on every pull request and main push.

This closes the CI-coverage gap only. It does not claim GitHub-hosted execution, deployment, protected Messages production reconciliation, release-lineage acceptance, outbox activation, or whole-project readiness.

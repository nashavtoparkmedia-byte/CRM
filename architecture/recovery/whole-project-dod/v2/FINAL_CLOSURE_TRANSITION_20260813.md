# Final closure transition

The current source commit intentionally remains in
`IMPLEMENTED_NOT_ACCEPTED`: the seven remediation findings are 0/7 `CLOSED`
and the canonical original DoD is 5/22 `CLOSED`. The PENDING template at
`FINAL_EXTERNAL_REREVIEW_CLOSURE.template.json` grants no acceptance.

Closure is a two-commit transition:

1. Accept and deploy one exact source commit after two clean reproductions and
   the exact hosted 52-control workflow.
2. Commit only the two ledgers, the final closure document, and the eight
   named evidence documents. The accepted source commit must be the direct
   parent. Any other changed path fails the verifier.

`FINAL_EXTERNAL_REREVIEW_CLOSURE.json` is deliberately non-self-referential.
It records the accepted source commit/tree, the exact changed-path allowlist,
and hashes of the eight evidence files. It does not record its own evidence
commit or tree. The verifier derives those identities from Git and reports
them after verification.

The final evidence set must bind:

- exact hosted run, two successful jobs, Gravity artifact, workflow and runner
  hashes, and all 52 ordered PASS controls;
- two distinct clean-checkout reproductions with explicit locked installs and
  Prisma generation;
- the source-bound Runtime 2.0.0-10 release seal and authorized Owner
  bootstrap following a separate internal review;
- a fresh Runtime 2.0.0-10 production transcript for version, self-check,
  preflight, activation, audit, canonical 62-row database status, Gravity and
  Telegram identity/health;
- all eight ordered internal attacks, with a critic assertion distinct from
  the executor assertion.

Only that complete evidence permits exactly 7/7 finding rows and 22/22
canonical rows to transition to `CLOSED`. Partial closure, Runtime v9,
stale production evidence, duplicate JSON keys, CI source/hash drift,
51/52 or reordered controls, a self-issued critic, and evidence-diff widening
all fail closed. The external project re-review remains explicitly unsatisfied;
the resulting state is only ready for a new independent external re-review.

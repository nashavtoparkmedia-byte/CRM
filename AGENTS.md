# YOKO CRM Release Governance Map

## Scope

- This file maps release work to the detailed policy in `docs/release/`.
- It applies to replacement-release preparation, evidence, Runtime, recovery,
  rollback, and production activation work in this repository.
- It does not replace product-development instructions outside release scope.
- The frozen acceptance scope is authoritative; do not broaden it for tooling
  preferences, speculative hardening, or unrelated architecture work.

## Sources of truth

- `docs/release/ACCEPTANCE_CHARTER.md` defines release gates and blocker classes.
- `docs/release/THREAT_MODEL.md` defines the same-trust repository model.
- `docs/release/CURRENT_CHECKPOINT.json` records exact current identities.
- `docs/release/DECISIONS.md` records curator decisions and their rationale.
- Exact immutable release artifacts override prose summaries when identities
  disagree.

## Candidate discipline

- One candidate receives one genuinely independent review.
- At most one repair is allowed for a concrete in-scope defect found by that
  review.
- A repair must change only the dependency invalidated by the defect.
- Requalify exact-SHA evidence only when the dependency contract requires it.
- Do not reopen accepted authority, loader, import-grammar, or evidence semantics
  without a mechanically invalidated dependency.
- Do not let review requests create an unbounded acceptance redesign.

## Release-critical blockers

- Candidate source or tree identity differs from the accepted identity.
- Required authoritative CI is missing, stale, non-reproducible, or failing.
- Required Gravity artifact identity is missing or not bound to candidate source.
- Current predecessor cannot be deterministically recreated by rollback.
- Release seal, Runtime package, policy, registry, or recovery evidence is invalid.
- A required independent review is absent or rejects an in-scope property.
- Production has drifted after the last freshness proof used for authorization.
- A required action crosses the Owner privileged boundary without authorization.

## Non-blocking tooling classes

- Alternative same-trust import spellings after the accepted boundary is proven.
- Node loader identity variants already closed by the accepted executable design.
- Repository code intentionally reading repository files in the same-trust model.
- Reviewer preferences that do not contradict a frozen release contract.
- Formatting, naming, or evidence presentation changes with no semantic impact.
- Unrelated application architecture or generalized platform hardening.

## Production freeze

- Keep PR #70 open and unmerged until Owner authorization.
- Keep `main` unchanged during replacement-release preparation.
- Do not start, stop, restart, recreate, or activate production services.
- Do not mutate production files, secrets, Compose, networks, volumes, or images.
- Do not mutate production databases, migrations, or application data.
- Read-only inspection is allowed only through finite project-scoped capabilities.
- Never delegate the Docker socket, a shell, arbitrary commands, or arbitrary paths.

## Predecessor evidence

- Derive the predecessor schema from actual activation and rollback semantics.
- Bind release-critical recreation configuration deterministically.
- Record mutable application/runtime state only when rollback explicitly restores it.
- Record observational metadata only when useful; do not make volatility a blocker.
- `crm_tg_bot_data` is preserved and reused by rollback.
- Bind its exact volume identity, `/app/data` target, read/write semantics, driver,
  and release-relevant options; do not hash all mutable volume contents.
- Do not emit secret plaintext.
- Do not create unsalted low-entropy secret-value guessing oracles.
- Reuse existing Compose identity and internal exact equality checks for effective
  environment/configuration binding.

## Privileged Runtime

- Extend the existing `/usr/local/sbin/yoko-privileged-runtime` architecture.
- Add no generic root mechanism.
- Prefer one narrow zero-argument predecessor observation primitive.
- Bind every permitted resource through immutable policy/registry data.
- The observation path may inspect and hash but must be mechanically read-only.
- Add negative tests for mutation verbs, arbitrary resources, and arbitrary paths.
- Build and audit the package before requesting installation.
- Prove package checksum, installed-file inventory, idempotency, and uninstall path.

## Independent review

- The implementation agent may prepare evidence but may not self-certify independence.
- A fresh reviewer consumes immutable candidate, artifact, Runtime, and predecessor
  evidence without importing raw authority capabilities.
- Review conclusions must identify the exact artifact and SHA reviewed.
- Only an in-scope defect may trigger the one-repair allowance.
- After a fresh predecessor pass, bind that accepted baseline through the existing
  release mechanism; do not substitute a new acceptance scheme.

## Owner boundary

- Installing or changing the privileged Runtime requires Owner authorization.
- Prepare exactly one checksum-pinned installation command.
- Do not execute the Owner command.
- After installation, verify identity and capture current predecessor evidence.
- Final Runtime/activation authorization also uses exactly one checksum-pinned command.
- Stop before production activation unless the Owner explicitly authorizes it.

## Required terminal states

- Before Runtime installation: `PREDECESSOR OBSERVABILITY CAPABILITY READY — OWNER INSTALLATION REQUIRED`.
- Before predecessor review: `CURRENT PREDECESSOR BASELINE EVIDENCE READY — INDEPENDENT RE-ACCEPTANCE REQUIRED`.
- Before activation: `REPLACEMENT CANDIDATE READY — WAITING FOR CURATOR OWNER-RUNTIME AUTHORIZATION`.

## Operating rule

- Continue autonomously through all unprivileged source, evidence, CI, Gravity,
  predecessor, seal, Runtime, and recovery checks.
- Stop only at an unavoidable Owner boundary, a real frozen-charter blocker, or
  immediately before production activation.

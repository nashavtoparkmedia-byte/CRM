# Current recovery handoff

Captured: `2026-08-11T23:32:21Z`

This is the authoritative continuation checkpoint for the current task. It is a handoff, not an acceptance artifact. The whole-project state remains `EXTERNAL_FINAL_ACCEPTANCE_FAILED`; the current program remains `WHOLE-PROJECT DOD RECOVERY`; the project is **not READY**.

Latest live-debt checkpoint (implementation HEAD `d0993b26`): strict architecture enforcement scans 1,216 files across 16 contexts with 117 findings, all 117 still temporary exception-covered debt, zero uncovered findings, zero stale exceptions, zero dependency cycles, and zero detector/digest errors. The rule counts are 31 internal imports, 63 non-public cross-context imports, 23 undeclared dependencies, zero provider-transport accesses, and zero direct foreign Prisma writes. Exactly 1,171 findings have been actually closed since the 1,288-finding opening denominator. Since the previous durable checkpoint, eight AI Knowledge/Calling/Operations semantic batches closed 40 findings without adding exceptions, including controlled migration, extraction execution, provider transport and operational-script consumers. The next bounded cluster is the four-finding AI Knowledge coach capability; no whole-repository write scan is warranted.

The machine-readable companion, `CURRENT_RECOVERY_HANDOFF.json`, contains the exhaustive every-path status/purpose inventory, exact commands/results, identities, worktree records, and next action. Read both files before changing code.

## Bounded analyzer and current baseline update

Ownership closure is internally accepted after the final bounded scan: `1,725/1,725` surfaces, zero worker failures/timeouts, `1,404` confirmed writes discovered, `0` confirmed foreign, `53` closed foreign, `46` raw ambiguous records reconciled exactly (`30` resolved non-writes, `11` owner-valid writes, `5` controlled migrations), zero material unresolved, zero dynamic delegate/SQL/queryRaw ambiguity, and zero unclassified operational surfaces. Current artifacts are `AUTHORITATIVE_WRITE_SCAN_20260811T131500Z.json`, `CURRENT_WHOLE_REPOSITORY_WRITE_BASELINE.json`, `CURRENT_WHOLE_REPOSITORY_WRITE_PROGRESS.jsonl`, and `AMBIGUOUS_WRITE_TRIAGE_FINAL_CLOSURE.json`. Security/credential closure and its independent critic pass are also internally accepted; the program remains **not READY** because live architecture debt and final CI/production acceptance remain open.

The analyzer execution recovery is complete, but it is not an acceptance. Commits `a1c0d20e` and `3ab9ad96` add fresh-process JavaScript workers capped at four, a 120-second per-surface deadline, structured progress, and atomic output; all 77 write fixtures and four companion suites passed before the scan.

Exactly one authoritative whole-repository scan was run after the final fix. It completed `1,639/1,639` tracked executable surfaces in `320082ms`, with zero worker failures and zero timeouts. Its current evidence is `AUTHORITATIVE_WRITE_SCAN_20260810T2102Z.json`, `CURRENT_WHOLE_REPOSITORY_WRITE_BASELINE.json` (SHA-256 `73259b98675789afb00258c1f1fac33c8799202f962b9944001a9bf05cfdf003`), and `CURRENT_WHOLE_REPOSITORY_WRITE_PROGRESS.jsonl` (SHA-256 `bb77f0b8a5e1f5ebb310f1ec7c61a19cef53b699f8a40abe2b662b7911181ee5`). The previous interrupted attempt is retained as non-authoritative evidence in `WRITE_EXECUTION_ATTEMPT_1_INTERRUPTED.jsonl`.

Historical superseded checkpoint: `1,578` write sites included `47 FOREIGN`, `640 AMBIGUOUS`, and `438` unreviewed operational surfaces. The old `WHOLE_REPOSITORY_WRITE_BASELINE.json` remains historical, from `3339325f`, and must not be used as the current baseline. This paragraph is retained only as recovery lineage; the accepted current write metrics are in the first paragraph of this section.

Historical derived-classification checkpoint: `CURRENT_WRITE_OWNERSHIP_DERIVED_STATE.json` once recorded 1,213 confirmed writes, 49 raw confirmed foreign records and unresolved dynamic classes. It is preserved as lineage and is superseded by the accepted 1,404/0/53 ownership metrics above.

## Source and Git state

- Common repository: `/opt/codex-work/crm/.git`
- Repository root recorded by the recovery identity: `/opt/codex-work/crm`
- Actual persistent recovery worktree: `/opt/codex-work/crm-architecture-dod-recovery`
- Branch: `codex/crm-architecture-dod-recovery`
- Upstream: none; no remote-tracking ref contains the implementation HEAD
- Recovery base: `0b61ba296ba2734738d4a21b9d00ce8b110d63cf`, tree `56c452397df4bb7cb05bef3e0d9afd1de9d785a5`
- Implementation HEAD before this checkpoint: `d0993b261498c0179449e4ba0be1f8062ef45822`, tree `95d79b40f19959b24079c8e0d2d846753c33feda`
- Checkpoint commit: the commit containing this file; resolve exactly with `git log -1 -- architecture/recovery/whole-project-dod/v2/CURRENT_RECOVERY_HANDOFF.md`
- Task range before checkpoint: `0b61ba29..d0993b26`, 150 commits, 873 paths, 1,859,407 insertions and 30,235 deletions

The original recovery checkpoint recorded 0 staged, 67 unstaged tracked paths (65 modified, two deleted), and 36 untracked paths. Those values are retained as historical attribution evidence only. Before this live-debt checkpoint update, all implementation batches through `d0993b26` were committed and the worktree was clean.

This checkpoint update contains only the live-debt recompute, summary, remediation plan, current handoff companions, and their targeted v2 checksums. The implementation and internally accepted security/credential work are already preserved in the recovery branch. Do not reset, clean, discard, or remove this worktree.

The invocation checkout `/opt/codex-work/crm` is a different protected pre-existing dirty worktree on `codex/test-ai-knowledge-textutils`, HEAD `ee93f8e2e964e523c5f3922a906ce110e491b4e4`, upstream `origin/codex/test-ai-knowledge-textutils` ahead 6/behind 0, with 0 staged / 46 unstaged / 207 untracked. It is not the recovery implementation worktree.

## Related and protected worktrees

Recovery-related clean worktrees:

- `/opt/codex-work/crm-arch-007r-final-hardening`: branch `codex/crm-arch-007r-final-hardening`, HEAD `0b61ba29`; source/base substrate.
- `/opt/codex-work/crm-analyzer-freeze-607386ac`: detached `88acc188`; earlier analyzer freeze.
- `/opt/codex-work/crm-architecture-analyzer-freeze-3339325f`: clean, detached `4ec52730`; current freeze mirror.
- `/opt/codex-work/crm-architecture-analyzer-repro-3339325f`: clean, detached `4ec52730`; current reproducibility mirror.

Other dirty/protected worktrees that this task did not mutate:

- `/opt/codex-work/crm-ai-calls`: `dev/ai-calls-product-preview-v2`, `b38b22d3`, 0/8/157.
- `/opt/codex-work/crm-arch-007r-ai-legacy-entry`: `99d3fd2c`, 0/1/7.
- `/opt/codex-work/crm-arch-007r-ai-legacy-entry-v2`: `53f08e23`, 0/3/0.
- `/opt/codex-work/crm-prod-snapshot-candidate`: detached `e6a0a833`, 0/37/8; ownership affected.
- `/opt/codex-work/crm-messages-remediation-clean`: `dev/messages-complete-remediation`, `50ae48a5`; index matches HEAD, but full status is indeterminate because root-owned mode-0700 paths produce read errors. Never claim it is clean from this checkpoint.

There are 117 registered worktrees, none Git-locked or prunable. “Protected” here is semantic/user protection, not a Git worktree lock.

## Exact implementation inventory

The companion JSON keys `committed_file_purpose_groups`, `uncommitted_file_purpose_groups`, and `path_status_inventory` enumerate every file created, modified or deleted and give its purpose. Counts are exact:

- Before checkpoint: 21 created committed paths, one committed modification, no committed deletion/rename.
- Checkpoint evidence: nine created paths under `architecture/recovery/whole-project-dod/v2/`.
- Still uncommitted: 32 created, 65 modified, two deleted, zero renamed.
- Deleted but preserved in Git worktree state: `gravity-mvp/src/app/api/debug-db/list-connections/route.ts` and `tg-bot/tg-bot-frontend/pages/api/export.js`.

The committed implementation comprises:

- Recovery truth/control-plane evidence: external NOT READY review, recovery identity, gap/state-mutation ledgers, executor/critic reviews, Runtime V2 reconciliation and checksums.
- Analyzer v2: `analyze.mjs`, tracked surface inventory, write/SQL/credential analyzers, all five test drivers, and the `gravity-mvp/debug-drivers.js` corpus correction.

The uncommitted implementation comprises:

- Context dependency/credential declarations and hashes; exactly 11 reviewed stale Identity dependency exceptions removed; AI boundary guard synchronized.
- Gravity integration-admin signed HttpOnly session and page/action gating.
- Fleet/MAX/Telegram/WhatsApp/AI public metadata projections that keep credentials/session material server-side.
- Bounded in-memory WhatsApp QR and Telegram login ceremonies.
- Gravity public/debug boundary detector and nine targeted security test files.
- Debug DB route removal plus Next/Nginx 404 boundary and production-image debug/repair exclusions.
- tg-bot fail-closed Basic auth, centralized secret redaction, metadata-only bot DTOs, token-free secret-header webhook, signed frontend session and same-origin server proxy.
- Required secret documentation and credential-safe diagnostics.

No code was lost or discarded. All worktree-only code remains under `/opt/codex-work/crm-architecture-dod-recovery`.

## Durable project state

Authoritative state root: `/opt/codex-work/crm-architecture-state`.

- `PROJECT_STATE.json` and `PROJECT_STATE.md`
- `ROADMAP_LEDGER.json`
- `MILESTONE_LEDGER.json`
- `FINAL_DOD_GAP_LEDGER.json`
- `KNOWN_EXCEPTIONS.json`
- `PRODUCTION_CHANGE_LEDGER.json`
- `EVIDENCE_INDEX.json`
- `WHOLE_PROJECT_EVIDENCE_INDEX.json`
- `ARCHITECTURE_DECISIONS.md`

This task updated `PROJECT_STATE.json`, `PROJECT_STATE.md`, `MILESTONE_LEDGER.json`, `ROADMAP_LEDGER.json`, `ARCHITECTURE_DECISIONS.md`, `KNOWN_EXCEPTIONS.json`, `PRODUCTION_CHANGE_LEDGER.json`, and `EVIDENCE_INDEX.json`; it created `FINAL_DOD_GAP_LEDGER.json` and `WHOLE_PROJECT_EVIDENCE_INDEX.json`. This checkpoint additionally updates only the `PROJECT_STATE.json`, `EVIDENCE_INDEX.json`, and `WHOLE_PROJECT_EVIDENCE_INDEX.json` continuation pointers.

Authoritative current values:

- State: `EXTERNAL_FINAL_ACCEPTANCE_FAILED`
- Current milestone/program: `WHOLE-PROJECT DOD RECOVERY IN PROGRESS`
- Gate: `IN_PROGRESS_AFTER_EXTERNAL_FINAL_ACCEPTANCE_FAILED`
- Gap ledger: 19 total, 17 `CONFIRMED`, two `CLOSED`, zero blocked
- Production change ledger: zero production source changes, database mutations, restarts/reloads, deployments, and rollbacks

## What this task actually completed

### CLOSED

- `FINAL-DOD-016`: installed Privileged Runtime `2.0.0-5` identity and finite 24-command ABI independently reconciled; evidence is `architecture/recovery/control-plane/v2/CONTROL_PLANE_RECONCILIATION.json`.
- `FINAL-DOD-017`: the Architecture Lead retained the original whole-project Definition of Done; evidence is the durable gap ledger.

No other `FINAL-DOD-*` finding is closed by this checkpoint.

### IMPLEMENTED BUT NOT YET ACCEPTED

- Analyzer v2 hardening through `4ec52730` exists and targeted tests pass, but there is no bounded current whole-repository baseline, current determinism result, or final critic PASS.
- Gravity/tg-bot credential, auth, session, redaction, webhook, QR/login, public DTO and debug-boundary hardening exists in the worktree. Delegated targeted tests and builds pass, but independent critic/final integration/production gates are absent.
- The context/enforcement slice removes 11 stale Identity exceptions and locally reports `1284 findings / 1284 exact exceptions`; this does not close the remaining whole-program architecture debt.

### INVESTIGATED

- Two mirrored current full scans were measured for more than 3h20 each, found CPU-active but operationally unbounded, and aborted without output.
- Per-file localization and a production-option probe narrowed the performance issue but did not prove a dominant root cause.
- Git/worktree, process/artifact, durable-state and Runtime V2 identities were reconciled for continuation.

### NOT STARTED

- Bounded worker/progress-instrumented analyzer execution and a current authoritative full scan.
- Current authoritative credential inventory after performance closure.
- Independent final critic/integration acceptance of analyzer and security work.
- Protected Messages authoritative production-source reconciliation.
- Production source/artifact identity reconciliation, preview/backup/rollback, deploy, runtime activation, or enabling Runtime V2 activation profiles.
- Transactional outbox activation and remaining architecture contract/manifest/CI/debt recovery.

## Write analyzer state

The historical enforcer was root-limited and primarily regex-based. It missed delegate casts and structural equivalents, excluded tracked operational scripts, authorized writers at broad file/model granularity, and checked environment credentials rather than database credential access. Analyzer v2 now inventories every Git-tracked executable surface and applies AST, SQL/mixed-script and credential analysis.

Scan roots are `git ls-files -z` across `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.sql`, `.sh`, `.py`, `.ps1`, `.bat`, `.yml`, `.yaml`, `.prisma`, Dockerfile variants and `package.json`. Surfaces are classified as application runtime, operational script, migration, test, generated, fixture or dead historical; deleted tracked files are excluded.

Exact analyzer files are the 11 `tools/architecture/v2/*.mjs` implementation/test files listed in the companion JSON plus `gravity-mvp/debug-drivers.js`. The current write test driver contains 77 fixtures. Covered properties include:

- direct delegates, parentheses/casts/assertions/non-null/optional chains and `(prisma.model as any)`;
- imports, aliases, destructuring, operation aliases, transactions/callbacks, helper parameters, dynamic imports and CJS/ESM constructors;
- dynamic delegates, nested relation writes/projections, mutable projections and cycle/recursion guards;
- raw SQL/queryRaw/CALL/COPY/DO, dialect/DDL/stored routine/RETURNING/USING forms and comment/string false positives;
- Drizzle typed aliases/descriptors plus Object/Map/Reflect/fromEntries/seal/prototype holders, helper parameters and dynamic ambiguity;
- prepared SQLite/general drivers, asyncpg cursors, and shell/Python/PowerShell/batch/JavaScript child-process database commands;
- credential reads/writes/public-route risk and fail-closed dynamic targets without serializing literal secret values.

Current targeted suite command, executed in **both** clean detached `4ec52730` mirrors:

```bash
NODE=/home/codexbot/.local/node-v22.18.0-linux-x64/bin/node
"$NODE" tools/architecture/v2/test-write-analyzer.mjs >/dev/null
"$NODE" tools/architecture/v2/test-analyze.mjs
"$NODE" tools/architecture/v2/test-surface-inventory.mjs
"$NODE" tools/architecture/v2/test-credential-analyzer.mjs
"$NODE" tools/architecture/v2/test-credential-inventory.mjs
git status --short
```

Both commands exited 0 and both mirrors stayed clean. The final mirrored write-test line was suppressed; the source has 77 fixtures and the latest visible `8aa469b8` run showed `77/77`. The four companion suites printed PASS. This is targeted evidence, not a whole-repository PASS.

### Current performance evidence

At `2026-08-10T16:25:26Z`, identical full scans started in the two clean `4ec52730` mirrors:

```bash
/home/codexbot/.local/node-v22.18.0-linux-x64/bin/node tools/architecture/v2/analyze.mjs --root . --output /tmp/yoko-write-freeze-4ec52730.json
/home/codexbot/.local/node-v22.18.0-linux-x64/bin/node tools/architecture/v2/analyze.mjs --root . --output /tmp/yoko-write-repro-4ec52730.json
```

Freeze shell/node PIDs were `1221688/1221692`; repro shell/node PIDs were `1221698/1221703`. At `19:46:21Z`, each had run `03:20:54` wall. CPU times were `03:18:19` and `03:18:06`, CPU utilization `98.7%` and `98.6%`, RSS `416656` and `414264` KiB. The driver emits no progress and writes JSON only after complete return. Therefore the truthful classification is `PROGRESS UNKNOWN DUE TO MISSING INSTRUMENTATION`, while the execution is operationally pathological/unbounded—not “stalled” in the CPU sense.

Both shell groups were stopped with Ctrl-C at `19:47:05/06Z`, exit 130, because duplicated deterministic work had consumed more than 198 CPU minutes each without bounded completion or output. Their queued credential commands never began. At `20:11:12Z`, no analyzer, credential-inventory, localization, diagnostic, or worktree-CWD process remained. Unrelated production/Docker/node processes were not touched.

All four requested current outputs are absent:

- `/tmp/yoko-write-freeze-4ec52730.json`
- `/tmp/yoko-write-repro-4ec52730.json`
- `/tmp/yoko-credential-freeze-4ec52730.json`
- `/tmp/yoko-credential-repro-4ec52730.json`

No partial JSON or useful stdout/stderr log exists. These aborted scans are **not PASS evidence**.

Cold per-file localization analyzed 1,507 tracked JS-family files with 16 fresh processes and a 15-second/file timeout from `19:47:21Z` to `19:52:13Z`. Only `tools/architecture/v2/write-analyzer.mjs` exceeded 15 seconds; every other isolated file stayed below the timeout. A second 16-way, 30-second/file probe supplied production `knownModels` and `relationFields`; it emitted no timeout/nonzero candidate through the last observation, but its final exit status was lost as `Unknown process id 73660`. It is diagnostic only. The exact probe is preserved at `continuation/PER_FILE_LOCALIZATION_PROBE.mjs`, SHA-256 `d963f6be67c828b8c26db1eddd3cdc33452a4960148e8f691644715deb20b056`.

### Proven versus hypothesis

Proven:

- The two current full scans consumed more than 3h18 CPU each without completion.
- `analyzePrismaWriteSites` creates a fresh TypeScript SourceFile, CompilerHost, Program and checker for every JS-family file call.
- The repository driver traverses surfaces serially and has no progress instrumentation.
- Isolated file runs did not identify a normal production file that individually explains the >3h run.
- `5a4211a4` used the same per-file Program architecture and completed a mirrored full pair in about 65 seconds; later analyzer commits superseded those outputs.
- RSS remained approximately 414–417 MiB; that does not settle cumulative-state cost.

Not proven:

- That repeated TypeScript Program construction is the dominant cause.
- That accumulated long-lived TypeScript/analyzer state is the dominant cause.
- That Map/Reflect/holder or Drizzle helper-parameter resolution is the dominant cause.
- That another specific full-driver algorithmic interaction is the dominant cause.

The current root-cause status is therefore `NOT PROVEN`. Prior wording that called accumulation “confirmed” was too strong and is superseded by this checkpoint.

## Other tests and enforcement actually run

- Gravity: `npm run test:security-boundaries` with the project Node toolchain — 34/34 across nine files, PASS.
- tg-bot: `PATH=/home/codexbot/.local/node/bin:$PATH npm run test:security-boundaries` — final delegated result 14/14 PASS; an earlier intermediate run was 13/13.
- Gravity and tg-bot frontend: `npm run build` — both production builds PASS; tg-bot frontend generated 10 static pages.
- Gravity: `npm run test:security-boundaries:build` — built debug/public boundary check PASS.
- Gravity `npx tsc --noEmit --pretty false` — 28 inherited diagnostics; no diagnostics in the new security paths. Targeted ESLint over the new security paths PASS.
- `node tools/architecture/validate-context-manifests.mjs` — PASS.
- `node --test tools/architecture/__tests__/context-manifests.test.mjs` — 8/8 negative tests PASS.
- `node tools/architecture/enforce-architecture.mjs` — strict local PASS at `1284 findings / 1284 exact exceptions`; this is not zero debt.
- `node tools/architecture/check-calling-ai-agent-config-boundary.mjs` — 10/10 PASS.
- `sha256sum -c architecture/contexts/v1/SHA256SUMS` — 31/31 PASS.
- `git diff --check` — PASS.

The exact command strings and scopes are in `CURRENT_RECOVERY_HANDOFF.json:test_and_enforcement_state`. No new validation was run during checkpoint creation beyond JSON/checksum/Git integrity checks.

## Evidence and temporary artifacts

Durable continuation artifacts:

- `CURRENT_RECOVERY_HANDOFF.md` and `.json`
- `continuation/ANALYZER_DIAGNOSTIC_CHECKPOINT.json`
- `continuation/PER_FILE_LOCALIZATION_PROBE.mjs`
- `SHA256SUMS`

The four preserved v2 phase artifacts (`ANALYZER_PHASE_IDENTITY.json`, both baselines, `REVIEW-1-EXECUTOR.md`) belong to critic-blocked commit `3339325f`/tree `68e1…`. They are committed only as historical evidence and are explicitly obsolete/superseded. They must not be promoted as the current `4ec52730` baseline or acceptance.

The last completed mirror pair in `/tmp` is from superseded `5a4211a4`: write outputs SHA-256 `faafd0868436ca95ff064093ed585c464a8fc4ca410c4dd3daa8a7ec93138575`; credential outputs SHA-256 `98f8113586c93eb840f873721cc722c98d4edd256943af0d090b66127d9b3326`. Counts and identities are preserved in the diagnostic JSON. The large stale files and unrelated WIP `/tmp` clutter were intentionally not copied.

## Current identities

- Recovery source: reconciled. Repository/worktree/branch/base are above; truth evidence commit/tree are `df91833a3f473b3827e39e1a48f1576f36435989` / `39541d7326ee3a308834ac19c0b9448055be61cc`.
- Production source/artifact identity: `NOT RECONCILED IN THIS TASK`.
- Messages authoritative production source identity: `NOT RECONCILED IN THIS TASK`.
- Installed YOKO Privileged Runtime V2: reconciled as package `yoko-privileged-runtime 2.0.0-5`; runtime SHA-256 `0cdeeb4ba43abe50f80fed1580ad7b0729bf83358932ece2974b3faedafed57a`; policy `e67159bf95b583a17073ccf34b95f17fb885321df10b742be970168331d64e38`; registry `6e0ac1bdf7bbf95b5ae984dc266050a86425aac1bd884f3ab2f1b6f377291016`; sudoers `6e6b7cb2a088cc92fa7aee747adca46c64b4b96d1224be21117be5adef488c06`; self-check true; 24-command finite ABI; activation profiles disabled fail-closed.

## Production mutation truth

This task made zero production source mutations, database mutations, service restarts/reloads, deployments, or rollbacks. Recovery source gained narrow protected-Messages imports and a Calling-owned chat-completion operation; private MessageService behavior and AI Calls request/tool payloads remain preserved by focused source and runtime gates. Production/runtime identity was read-only where reconciled; no production activation was attempted.

## Genuine blockers

- 117 temporary exact architecture exceptions remain live debt.
- Authoritative final CI, protected Messages reconciliation, and production source/artifact acceptance remain incomplete.
- Recovery lineage is local-only with no upstream/remote tracking ref.

## Exact next action

Write ownership and credential/security closure remain internally accepted. The current credential inventory is `403` accesses with `81` statically ambiguous records fully classified, `0` material unresolved, `0` confirmed public exposure, and `0` cross-domain capability gaps. Continue automatically with the four-finding `AI KNOWLEDGE COACH CAPABILITY` cluster: expose only the exact coach operation and result DTOs required by protected Messages, preserve item-id filtering and error containment, and expose no generic LLM client, prompt or knowledge writer capability. Preserve Messages and AI Calls behavior and do not repeat the whole-repository write scan.

### Live architecture debt recompute

The bounded recompute scanned 1,216 files across 16 contexts. Current live debt is: 31 internal imports, 63 non-public cross-context imports, 23 undeclared dependencies, 0 provider-transport accesses, 0 direct foreign Prisma writes, 0 uncovered findings, and 0 stale exceptions (117 findings / 117 exception-covered). Temporary exceptions are 117; intentional exceptions are 0; 1,171 findings are actually closed from the opening denominator. Detector parse and finding-digest health are clean. This is `NOT_READY_LIVE_DEBT_REMAINS`; evidence is in `LIVE_ARCHITECTURE_DEBT_RECOMPUTE_20260811.json` and `LIVE_ARCHITECTURE_DEBT_SUMMARY_20260811.json`.

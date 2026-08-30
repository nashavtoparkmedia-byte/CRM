# Autonomous delivery with Codex

YOKO CRM repository instructions and machine-readable architecture remain the
authority. This guide defines a delivery workflow only; it does not redefine
domain ownership, contracts, migrations, credentials, privileges, or release
policy.

## Operating model

- Use one write-capable primary Codex thread per worktree.
- Delegate bounded reconnaissance, impact mapping, CI investigation, and review
  only through the seven repository profiles in `.codex/agents/`. Their native
  read-only sandboxes, no-approval policy, and instructions are layered controls;
  do not use a built-in, default, or otherwise unconfigured role. The primary
  thread owns every edit, repair, commit, branch operation, and push.
- Keep reviewer results concise and evidence-based. Use
  `.codex/schemas/reviewer-result.schema.json` and reject nonconforming results
  before use. A `PASS` has no findings; `PASS_WITH_FINDINGS` and `FAIL` have at
  least one. Do not flood the main thread with raw logs.
- State uncertainty explicitly. Reviewer output is advice, not architecture
  authority.

## Delivery boundary

Develop through repository reconnaissance, implementation, proportional local
verification, independent read-only review, repair, retest, commit, and push.
Record the exact pushed remote HEAD.

`PUSHED_WAITING_CI` is the concrete waiting-CI handoff. At that boundary, active
model execution stops. Codex must not spend an active turn polling hosted CI.
An external mechanism may later resume Codex with the expected HEAD and a
bounded failure digest; external execution state is never authoritative over the
repository.

Do not claim a stage complete until every gate required by that stage is proven.
Human approval remains legitimate for business or architecture decisions,
unavailable credentials or MFA, protected repository actions, physical actions,
and explicitly authorized production or real-world operations.

## Safety boundary

This workflow grants no automatic authority for production changes, migrations,
deployments, provider or billing actions, secret changes, telephony, or real
calls. It adds no external operator, webhook service, CI workflow, or automatic
resume mechanism.

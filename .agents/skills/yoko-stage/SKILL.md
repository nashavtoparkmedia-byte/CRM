---
name: yoko-stage
description: Deliver a bounded YOKO CRM engineering stage from repository-authority bootstrap through implementation, targeted verification, independent read-only review, repair, commit, and push. Use when a YOKO task should produce one pushed candidate and stop model execution at PUSHED_WAITING_CI instead of polling hosted CI.
---

# YOKO stage delivery

Use one write-capable primary Codex thread per worktree. Keep delegated work
read-only and keep repository architecture authoritative.

## Workflow

1. Fetch the requested base and inspect its exact remote SHA, worktrees, status,
   root `AGENTS.md`, the agent development contract, and relevant machine
   authority before designing changes. Start from a clean index and worktree; if
   an existing candidate is intentionally supplied, record its exact path
   allowlist before taking action.
2. Define the bounded outcome, owning context or tooling surface, explicit
   exclusions, and repository-selected blast radius.
3. Use `repository_explorer` and `impact_mapper` for bounded reconnaissance when
   parallel reads materially help. Delegate only to repository profiles in
   `.codex/agents/`. Validate results against the reviewer schema before use,
   including verdict/finding consistency, and require `changed_files: []`.
4. Let only the primary thread edit, test, commit, change branches, or push.
5. Implement the smallest architecture-consistent change. Do not weaken
   enforcement or expand production, provider, credential, billing, migration,
   deployment, or telephony authority.
6. Run proportional targeted verification selected by the real blast radius.
   Fix ordinary failures and rerun affected checks.
7. Run parallel `architecture_reviewer`, `diff_critic`, and
   `security_reviewer` reviews when relevant. Add `reliability_reviewer` for
   concurrency, replay, retry, recovery, or operational-state changes. Do not
   substitute a built-in, default, or unconfigured role.
8. Integrate actionable findings in the primary thread, then retest the repaired
   surface. Keep reviewer output bounded; do not paste raw logs into the main
   thread.
9. Confirm the intended diff, file modes, secrets boundary, and exact base
   relationship. Commit coherently, confirm the worktree is then clean, and push
   normally without force.
10. Resolve and record the exact pushed remote HEAD.

## CI boundary

After a successful push, report the exact HEAD and the terminal state:

`PUSHED_WAITING_CI`

Then stop model execution. Do not poll, watch, or wait on hosted GitHub CI from
the active turn. Do not claim `COMPLETE` unless the current stage explicitly
defines and proves all gates required for that claim. External automation may
resume a later task with a bounded CI digest; it is not architecture authority.

If push is impossible because a required credential or approval is genuinely
unavailable, stop at that defined external gate with exact evidence. Do not
widen permissions or invent another delivery path.

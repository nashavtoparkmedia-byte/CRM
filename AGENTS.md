# YOKO CRM repository instructions

These instructions apply to the entire repository. A nested `AGENTS.md` may add
stricter local rules for its subtree, but it must not weaken or contradict this
file.

## Canonical instruction hierarchy

1. This root `AGENTS.md` contains the mandatory repository-wide rules.
2. [Agent development contract](docs/architecture/AGENT_DEVELOPMENT_CONTRACT.md)
   explains how to apply them.
3. [New domain checklist](docs/architecture/NEW_DOMAIN_CHECKLIST.md) is required
   before substantial work on a new domain or module.
4. Existing manifests, registries, policies, and checks under `architecture/`
   and `tools/architecture/` remain the machine authority.

`CLAUDE.md`, `.cursorrules`, `.claude/`, IDE hints, and other tool-specific
instructions may add workflow or UI guidance. They do not redefine CRM
architecture, domain ownership, scope, credential, or privilege boundaries.

## Mandatory architecture rules

### Modular monolith

YOKO CRM is a **MODULAR MONOLITH**. Respect its existing boundaries. Do not
introduce microservices or new service boundaries merely for style.

### Domain ownership

Every meaningful feature belongs to an owning domain. A domain owns its
business rules, private implementation, data, allowed writes, and public
contracts. Before substantial implementation, identify the owner and inspect
the current context manifests and contract registry. For a new domain or
module, complete the new-domain checklist first.

### Foreign writes are forbidden

A domain must not directly mutate another domain's data because Prisma, SQL,
or an import makes it possible. Cross-domain mutation must use an accepted,
explicit public contract or repository mechanism.

### Private cross-domain access is forbidden

Another domain's internal implementation is not a public API. Do not import or
reach through neighboring private layers. If a needed public contract is
missing, define the smallest contract required; do not expose broad internals
or redesign the neighboring domain for convenience.

### Scope and blast radius

A task does not authorize unrelated cleanup. Prefer the smallest architecture-
consistent surface and locally relevant verification. Do not perform
"while I am here" refactors. If a request unexpectedly requires broad or
unrelated changes, stop and establish why before expanding scope.

### Data and migrations

Respect table and write-surface ownership. Migrations need an explicit domain
and architectural purpose; do not create them casually. Never mutate a foreign
table directly.

### Events, side effects, and outbox

Use the repository's accepted event/outbox patterns when atomicity or external
side effects require them. Do not add an outbox mechanically where that
guarantee is not required.

### External providers

Keep provider-specific behavior behind the owning integration/provider adapter
and out of provider-neutral domain logic.

### Secrets and privilege

Respect existing credential ownership and privileged-runtime boundaries. Never
weaken secret handling, sudo/runtime controls, or privileged capabilities for
development convenience.

### Existing enforcement is authoritative

Do not bypass, delete, weaken, skip, or fake architecture enforcement to make a
change pass. Repair a real boundary violation in the design. If enforcement is
demonstrably stale or broken, repair it narrowly and explicitly.

### No architecture reinvention

Inspect and reuse existing contexts, public contracts, adapters, events, and
checks before inventing a new pattern or parallel abstraction.

### Testing and owner interaction

Test the changed behavior and boundaries in proportion to the task. Do not run
huge unrelated suites merely "for safety", and do not claim success without
relevant verification. Perform routine investigation and testing yourself;
ask the Owner only for genuinely unavailable credentials, MFA or physical
interaction, or a real business decision.

## Autonomous delivery

- Use one write-capable primary Codex thread per worktree. Parallel subagents
  are read-only by default; delegate bounded reconnaissance, impact mapping, CI
  triage, and independent review, not implementation.
- Delegate only through the seven repository profiles in `.codex/agents/`; do
  not use a built-in, default, or otherwise unconfigured role.
- Return compact evidence-based findings instead of raw logs. The primary
  thread validates reviewer results before use and owns all edits, repairs,
  commits, branch operations, and pushes.
- Follow `docs/engineering/AUTONOMOUS_DELIVERY.md` and the repository skills
  without treating them or external execution state as architecture authority.
- After pushing a candidate, record the exact remote HEAD, report
  `PUSHED_WAITING_CI`, and stop model execution. Do not poll hosted CI from the
  active turn.
- Do not claim `COMPLETE` unless every gate required by the current stage has
  been proven.

## Machine-authoritative navigation

- Ownership and dependencies: `architecture/contexts/v1/context-index.json`,
  `architecture/contexts/v1/manifests/`, and
  `architecture/contexts/v1/NEW_MODULE_OPERATIONS.md`
- Public contracts: `architecture/contracts/v1/README.md` and
  `architecture/contracts/v1/registry.json`
- Boundary enforcement: `architecture/enforcement/v1/README.md` and
  `architecture/enforcement/v1/policy.json`
- Events/outbox: `architecture/events/v1/EVENT-SELECTION.md` and
  `architecture/events/v1/outbox-manifest.json`
- Migration authority: `architecture/migrations/v1/production-migration-authority.json`
- Blast-radius selection: `tools/architecture/check-blast-radius.mjs`

These sources are accepted architecture machinery. Reference them; do not
duplicate, casually regenerate, or rewrite their evidence chains.

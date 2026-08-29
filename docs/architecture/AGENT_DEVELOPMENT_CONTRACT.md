# YOKO CRM agent development contract

This is the canonical human/agent operating contract referenced by root
`AGENTS.md`. It explains how to develop within the accepted CRM architecture;
it does not replace the machine-readable manifests, registries, policies, or
checks under `architecture/` and `tools/architecture/`.

## Architectural model

YOKO CRM is a modular monolith. Deployable processes and external integrations
do not grant permission to invent new business-domain or service boundaries.
Keep cohesive business capabilities inside the monolith and use the existing
composition and adapter patterns. A new service boundary requires concrete
operational and architectural justification, not stylistic preference.

Before designing a change, inspect the current source and the accepted context
model. Directory proximity, a Prisma client, or a convenient import is not
proof of ownership.

## Existing machine authority

Use these sources instead of reconstructing architecture from memory:

- `architecture/contexts/v1/context-index.json` identifies bounded contexts.
- `architecture/contexts/v1/manifests/` records modules, ownership, allowed
  dependencies, providers, and credentials.
- `architecture/contexts/v1/NEW_MODULE_OPERATIONS.md` defines the accepted
  candidate scaffold and integration procedure.
- `architecture/contracts/v1/registry.json` and its `README.md` define current
  versioned public contracts.
- `architecture/enforcement/v1/policy.json`, its `README.md`, and the checks in
  `tools/architecture/` enforce boundary rules.
- `architecture/events/v1/EVENT-SELECTION.md` and `outbox-manifest.json` define
  accepted event/outbox choices.
- `architecture/migrations/v1/production-migration-authority.json` is the
  migration authority.

Files under `architecture/isolation/`, `architecture/recovery/`, and related
review/evidence directories bind accepted work and often carry checksums and
ledgers. They are evidence, not an invitation to copy or regenerate a new
development guide.

## Ownership and boundaries

Every meaningful change has an owning domain. The owner controls:

- business rules and invariants;
- private implementation and composition;
- owned data and tables;
- the permitted write surface;
- public commands, queries, events, and result types;
- provider adapters and credential use assigned to that domain.

Determine the owner before substantial implementation. Confirm it against the
current context manifest and actual code. If ownership is ambiguous, resolve
the boundary explicitly before writing across it.

Internal files, owner-side adapters, persistence models, Prisma handles, raw
SQL helpers, provider clients, and transaction objects are private unless an
accepted versioned public surface expressly exposes a safe abstraction.

## Dependency direction

Dependencies must follow the context manifests and accepted public surfaces.
A consumer may depend on a provider-neutral public command, query, event, or
type exposed by the owner. It must not import the owner's internal module,
persistence adapter, provider client, or framework details.

Public contracts live under the repository's versioned contract convention.
Do not change a major contract in place or leak persistence/provider types
through it. Existing compatibility and versioning rules are documented in
`architecture/contracts/v1/README.md`.

## Foreign write rule

Foreign writes are forbidden. Technical access is not architectural authority:
a domain may not mutate another domain's model or table via Prisma, raw SQL,
shared helpers, or a private import.

For cross-domain mutation:

1. identify the data owner;
2. look for an accepted public owner operation;
3. call that operation through its versioned public contract;
4. preserve the owner's validation, transaction, idempotency, audit, and event
   semantics;
5. add the smallest missing contract if no suitable operation exists.

Do not solve a missing operation by exposing a generic repository, Prisma
client, transaction callback, or unrestricted update payload.

## Data and migrations

Reads from another domain are allowed only through an accepted read contract,
read model, or specifically declared dependency. A schema table is not a
shared object merely because it resides in one database.

A migration must have an explicit owner and architectural purpose. Confirm the
active migration authority and ownership before creating or changing one.
Coordinate schema changes with public contracts and compatibility needs. Do
not create a migration as incidental cleanup, edit accepted migration evidence,
or directly alter another domain's owned tables.

## Events, side effects, and outbox

Choose synchronous contracts, events, and outbox delivery based on the needed
guarantee:

- use a direct public operation when the caller needs an immediate owner result;
- use an event when a completed domain fact is being communicated;
- use the accepted outbox pattern when a state transition and an external or
  asynchronous side effect must be atomically recorded for reliable delivery.

Do not emit vague integration events that expose internal state. Do not add an
outbox to every write mechanically. Follow the accepted selections and retry,
deduplication, and retention rules in `architecture/events/v1/`.

## Providers, secrets, and privilege

Provider SDKs, protocols, payload quirks, retries, and credentials belong
behind the provider/integration boundary assigned by the context manifests.
Domain logic should consume provider-neutral operations and results.

Credential names and access must remain within declared ownership. Values must
not cross public contracts or appear in source, logs, evidence, or command-line
arguments. Preserve existing privileged-runtime and capability boundaries; a
development shortcut is not justification for broader sudo, shell, Docker,
filesystem, package-install, or secret access.

## Scope and blast radius

Translate the request into an explicit in-scope outcome and an explicit list of
things that remain unchanged. A feature request does not authorize cleanup of
neighboring domains, shared-core redesign, migration churn, or architecture
modernization.

Prefer the smallest implementation that satisfies the request and accepted
boundaries. Use `tools/architecture/check-blast-radius.mjs` and locally relevant
checks when applicable. If the necessary change expands unexpectedly, stop and
identify whether the cause is a missing contract, incorrect ownership, stale
enforcement, or an actual architecture decision.

## Adding a new domain

First determine whether the capability belongs to an existing domain. A new
name in the product does not automatically require a new bounded context.

If a new domain/module is justified:

1. complete `docs/architecture/NEW_DOMAIN_CHECKLIST.md`;
2. inspect and follow `architecture/contexts/v1/NEW_MODULE_OPERATIONS.md`;
3. use the repository scaffold to create a candidate, not a live context entry;
4. review ownership, dependencies, public contracts, provider/credential use,
   writes, events, migrations, failure semantics, and tests together;
5. integrate it into machine authority only through the accepted process.

Do not add a folder and retroactively declare it a domain.

## Modifying an existing domain

Confirm the current owner manifest, its public surfaces, and the changed
invariants. Keep private changes private. Extend a public contract only when a
consumer genuinely needs it, version it according to the contract convention,
and test both owner behavior and the exposed boundary. Avoid touching consumers
that do not need the change.

## Cross-domain interaction

When one domain needs another:

1. state the business interaction in owner terms;
2. locate the existing public command, query, or event;
3. verify the dependency is allowed;
4. keep orchestration on the appropriate side of the boundary;
5. test the contract and relevant failure behavior.

When a public contract is missing, define only the required operation and
minimal provider-neutral data. The owning domain must retain its invariants and
write. Do not redesign that domain or export broad internals for convenience.

## Architecture changes

An architecture change needs explicit justification when it changes domain
ownership, dependency direction, public-contract responsibility, table/write
ownership, event guarantees, provider/credential ownership, or a service or
privilege boundary. Document the concrete need and alternatives, then update
the accepted machine-readable authority and targeted enforcement together.

If a checker exposes a real violation, repair the design. If a checker is
demonstrably stale or wrong, narrowly repair the checker and add a regression
test; never skip, fake, weaken, or broadly except it.

## Verification expectations

Verification follows changed scope:

- test changed business behavior and edge cases;
- test every added or changed public boundary;
- run the relevant architecture/boundary checks selected by the affected
  contexts and blast radius;
- prove failure behavior for guards and invariants where practical;
- confirm unrelated application, Runtime, database, release, and production
  surfaces remain untouched when they are out of scope.

Do not run unrelated multi-hour suites solely for reassurance. Existing hosted
automation may run normally, but do not manually duplicate it.

## Prohibited shortcuts

Do not:

- directly write another domain's data;
- import another domain's private implementation;
- expose Prisma, raw SQL, provider clients, credentials, or generic write
  capabilities through a public contract;
- add microservices or parallel abstractions for style;
- weaken enforcement, secrets, privilege, or audit boundaries;
- perform unrelated refactors or migrations;
- edit accepted evidence to make ordinary development fit it;
- declare success without task-relevant tests.

Routine investigation, implementation, and testing belong to the agent. Ask
the Owner only for unavailable credentials/MFA, physical or external action,
or a genuine business/architecture decision.

# YOKO CRM new domain/module checklist

Complete this checklist before major implementation of a genuinely new domain
or module. First verify that the requested capability does not belong inside an
existing bounded context. Reconcile every answer with the current context
manifests, contract registry, and enforcement policy; this document does not
override them.

## Decision record template

### 1. Domain name

Provide a stable business-capability name and proposed technical identifier.

### 2. Business responsibility

State the capability and invariants the domain owns in one bounded paragraph.

### 3. Owned data

List domain concepts and records it creates, controls, and retires.

### 4. Owned tables / write surface

List proposed tables/models and the exact writes the domain may perform. Mark
shared-looking or existing data explicitly as foreign-owned until proven
otherwise.

### 5. Public contracts exposed

List the smallest versioned commands, queries, events, and result types needed
by consumers. Do not expose persistence, provider, credential, or transaction
types.

### 6. Allowed dependencies

List each required domain/platform dependency and its accepted public surface.

### 7. Data read from other domains

List each read, its owner, purpose, consistency need, and accepted query/read
model. Direct table access is not automatically allowed.

### 8. Cross-domain writes

List every requested foreign state change, its owner, and the explicit public
command/event mechanism. If there are none, state `NONE`. Direct foreign writes
are forbidden.

### 9. Events emitted

List completed domain facts, schemas/versions, consumers, and delivery needs.

### 10. Events consumed

List accepted events, why they are consumed, and idempotency expectations.

### 11. External providers / adapters

List providers, protocols, and owner-local adapters. Keep provider-specific
state and behavior behind this boundary.

### 12. Secret / credential boundary

List credential names (never values), owning context, readers, and approved
runtime/privilege mechanism.

### 13. Side effect / outbox requirements

For each external/asynchronous effect, state whether atomic recording is
required and whether the accepted outbox applies. Explain `NONE` when it does
not.

### 14. Migration requirements

List schema/data changes, owner, compatibility/rollback plan, and migration
authority. Do not create a migration when no schema/data change is required.

### 15. Failure / retry / idempotency model

Describe failure states, timeouts, retry ownership, deduplication keys, and
idempotent operations where relevant.

### 16. Test boundary

List unit/domain tests, public-contract tests, adapter tests, relevant
architecture checks, and negative/fail-closed tests.

### 17. Observability requirements

List owner-safe metrics, structured events/logs, audit needs, and health signals
where relevant. Do not leak credentials or provider-sensitive payloads.

### 18. Explicitly out of scope

Name neighboring domains, data, refactors, migrations, providers, and behavior
that this work will not change.

## Pre-implementation gate

Do not start major implementation until:

- the owner and in/out-of-scope boundary are explicit;
- owned data and every write surface are classified;
- dependencies and public contracts are minimal and allowed;
- provider, credential, event/outbox, migration, and failure semantics are
  resolved where applicable;
- the accepted candidate/scaffold process in
  `architecture/contexts/v1/NEW_MODULE_OPERATIONS.md` has been followed when a
  new technical module is actually required;
- targeted verification is defined.

## Illustrative example: AI Calls

This example demonstrates reasoning, not a pre-approved architecture. Before
implementation, inspect the current `calling` context manifest and related
contracts to decide whether "AI Calls" extends that existing domain or merits a
new module. The example must not override accepted ownership.

### Proposed responsibility and ownership

AI Calls may own call-oriented concepts such as:

- campaigns and campaign call policy;
- call attempts and schedules;
- call lifecycle, outcomes, and result classification;
- provider-specific call state kept behind a calling-provider adapter;
- idempotency/retry state for initiating and reconciling calls.

It does **not** silently take ownership of Drivers, Messenger, Tasks, or Auth.
In current architecture terminology, verify the actual owners in the context
manifests (for example Fleet Operations, Messaging, Work Management, and
Identity Access) rather than relying on these product labels.

### Example interaction matrix

| Need | Owner remains | Permitted interaction | Forbidden shortcut |
| --- | --- | --- | --- |
| Select eligible drivers | Drivers/Fleet owner identified by current manifests | Minimal accepted query/read contract | Querying or updating foreign tables because Prisma can |
| Record a call in a conversation timeline | Messaging owner | Versioned public command/event accepted by Messaging | Importing Messaging internals or writing its tables |
| Create a follow-up task | Work Management/Tasks owner | Existing or minimal versioned owner command | Direct `Task` creation from AI Calls persistence code |
| Check actor/permission | Identity/Auth owner | Public authorization/identity contract | Reading or mutating private auth/session storage |
| Place a provider call | AI Calls/Calling provider adapter | Provider-neutral owner operation backed by the adapter | Spreading provider SDK/payload logic through domain code |

### Example events and side effects

AI Calls might emit versioned facts such as `CallAttemptCompleted` only after
the domain transition is valid. Starting a provider call or publishing a
result may require the accepted outbox when atomic state-plus-delivery is
needed. A simple synchronous, read-only provider query may not. Record the
guarantee instead of selecting outbox mechanically.

### Example explicit exclusions

Unless separately authorized, the AI Calls task does not refactor Drivers,
rewrite Messenger, change Tasks internals, redesign Auth, migrate unrelated
tables, create new service boundaries, or perform shared-core cleanup.

# CRM contract convention v1

Cross-context commands and results live under
`gravity-mvp/src/contracts/<owner-context>/v<major>/`. A contract identifier
contains the owner context, semantic name and major version. Producers import
the immutable version they emit; owner-side public entry points parse that
version before invoking a provider-neutral handler.

Compatibility rules:

1. A major version is never changed in place.
2. A v2 contract must be added beside v1; it cannot silently replace v1.
3. Owner contexts keep v1 and v2 dispatchers concurrently for the migration
   window, or provide an explicit, tested v1-to-v2 adapter.
4. Persistence, framework, credential and provider implementation types are
   forbidden in contract modules.
5. Legacy persistence may be used only through an owner-side compatibility
   adapter. Consumers cannot import that adapter.
6. Unknown fields and unsupported versions fail closed at the owner boundary.

CRM-ARCH-004 instantiates the convention with
`work_management.CreateTaskCommand.v1`. The representative Calling consumers
are the real and mock AI-call follow-up paths. Both retain their existing task
payload semantics while their direct foreign `Task` writes move behind Work
Management's public entry point.

Durable AI-call finalization uses the additive
`work_management.CreateIdempotentTaskCommand.v1`. Work Management derives a
deterministic Task identity from the caller-supplied idempotency key and returns
either `created` or `replayed`; a different payload for the same key fails
closed. The original `CreateTaskCommand.v1` remains unchanged for consumers
that do not require owner-enforced replay.

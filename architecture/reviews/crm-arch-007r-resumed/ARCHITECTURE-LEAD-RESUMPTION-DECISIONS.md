# CRM-ARCH-007R Architecture Lead resumption decisions

## Gate disposition

The explicit continuation resumes the paused CRM-ARCH-007+ source program. The former 67-write registry is corrected to a 115-site pre-retirement population after the fail-closed parser exposes 48 unsafe or unproven fragment sites. Retiring 12 constant owner-local DDL ambiguities leaves 103 implementable, bounded decisions without adding a cyclic dependency, generic SQL surface, public transaction handle, secret-bearing evidence, or production mutation.

## D1 — Static SQL ownership is evidence, not source debt

Twelve findings are false ambiguity caused by the enforcement parser. The affected SQL is constant, owner-local DDL for tables already assigned to Configuration or Operations Observability. Correct the parser fail-closed and regenerate the exact registry; do not relocate owner code or grant an exception.

Accepted parser boundary: only direct literals and lexically resolved single-literal `const` bindings without substitution are resolvable. Interpolation in table position, concatenation, mutable/shadowed bindings, unresolved identifiers and mixed-owner statements remain violations. Every tagged execute interpolation is fail-closed because plain-looking runtime values can carry Prisma SQL objects through aliases, objects, arrays or callable wrappers. Unicode target truncation and incomplete qualified targets are also fail-closed. Comments and SQL string values do not establish ownership.

Accepted exception identity: raw write fingerprints include named AST scope plus the exact call/tag signature; byte-identical same-scope sets are additionally file-digest salted. Removing one same-subject write cannot renumber a surviving sibling into the retired exception identity.

## D2 — Cross-owner lifecycle topology

- Archived-contact purge is an Operations-owned, deliberately non-transactional workflow. It invokes narrow Messaging, Work Management and Contacts commands strictly in the inherited order: detach conversations, detach tasks, delete contact. Direct Operations dependencies are acyclic.
- `ContactService.ensureChatLinked` moves wholly to Messaging; no Contacts compatibility wrapper may import Messaging.
- `scenario_field_settings` is reassigned to Work Management because its runtime reader/writer module and domain behavior are task scenario presentation. Configuration callers use Work public commands; Work must not depend on Configuration.
- Contact conversation endpoints and Fleet-to-Telegram/Fleet-to-Messaging delivery use cases move to Platform Shell/delivery orchestration, which already composes the relevant public surfaces. The domain contexts must not add reverse dependencies.
- Contact merge remains last. Its ordered row locks and 15-second multi-model transaction require one exact merge workflow coordinator with named repository ports (or an exact stored procedure), failure-injection rollback proof, and no generic transaction/SQL capability.

## D3 — Residual dynamic and multi-table persistence

- Retention event cleanup splits into fixed policy commands: Fleet owns DriverEvent and ApiLog cleanup; Messaging owns CommunicationEvent cleanup. Public contracts expose no table name, predicate, SQL, arbitrary interval or row limit.
- `intervention_actions` repository behavior, including compatibility DDL and all reads/writes, moves to Operations Observability. Analytics Reporting may depend on Operations; ID generation and outcome computation stay caller-owned.
- Health snapshot/history persistence and reads move to Operations Observability. The sole Analytics consumer imports Operations directly. No Work Management wrapper or Work-to-Operations edge is permitted because it would close an effective cycle through Messaging.

## D4 — AI settings decomposition and secret boundary

- The three credential-free legacy `KnowledgeBaseEntry` writes migrate first to strict AI Knowledge create/update/delete commands.
- Thirteen `AiKnowledgeItem` governance writes migrate as typed owner commands while authorization and audit ordering remain in the server action.
- Five physical `AiAgentConfig` writes belong to Calling, including `extractionQualityTier` until a schema split exists.
- The Calling patch command uses a strict ordered field union and constant column map. Credential-bearing input is opaque: it is never logged, serialized, returned, audited, placed in fixtures or emitted in evidence. The misleading physical field name is not evidence of encryption.
- Provider connection tests remain outside the persistence adapter and are never executed by architecture verification.

## Accepted implementation order

1. Fail-closed static SQL parser and strict-registry correction.
2. Legacy AI Knowledge entry owner commands (3 writes).
3. Fixed-policy retention event cleanup (1 dynamic write).
4. Archived-contact purge workflow (3 writes).
5. Intervention repository relocation (5 writes).
6. Manager-health repository relocation (6 writes).
7. Low-risk topology relocations, then the contact-merge transaction coordinator.
8. AI Knowledge governance commands, then secret-sensitive Calling configuration commands.
9. Replace all 48 surfaced unsafe or unproven fragment sites with fixed typed persistence operations; do not normalize them away as parser ambiguity.

Each source slice remains isolated, reversible, checksummed and production-inactive. A failed slice is rejected without blocking independent accepted work.

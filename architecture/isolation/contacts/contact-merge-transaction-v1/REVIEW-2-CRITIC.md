# Review 2 — independent critic

Status: `PASS_CONTINUE_SOURCE_GATE_WITH_PHYSICAL_ROLLBACK_DEFERRED`

The independent design review rejected a generic AsyncLocalStorage or ambient
Prisma transaction channel because it would expose a broad persistence
capability, hide transaction membership and introduce propagation, nesting,
HMR and closed-transaction risks. It selected the implemented named-repository
unit of work and exact file/model approved-writer pair as the narrow design
that preserves the legacy cross-owner atomic transaction without a dependency
cycle.

An independently authored offline checker and an independent rerun confirmed
the implemented shape. The public contract is closed and versioned. Repository
method names are exactly allowlisted. Simple, driver and both manual branches
retain their exact sequence. Preconditions and no-ops never enter the unit of
work. The adapter uses the sentinel callback transaction for mutation, with
default simple options and hardcoded `{ timeout: 15000 }` for full merges.
Its four Chat and one Task sites have exact predicates/data, and there is no
Message writer or global-Prisma mutation fallback.

The critic also confirmed the protected route and drawer hashes, the facade's
legacy signatures/results/error constructor, unchanged MessageService, stable
Chat ids and absence of provider transport. The exact strict comparison is
1,369->1,361 findings: only the eight documented `ContactMergeService`
foreign-write fingerprints retire. Additions, shared semantic changes and
location rebases are zero. Finding digest is
`fd306ea9812b7c9285bbdb7e0eaf2eae2b21abc538fb45354ce235d3c3bdeeac`.

The remaining limitation is material only beyond this delegated source gate:
fake transaction rollback tests do not prove PostgreSQL's physical rollback,
row-lock concurrency, constraints or timeout. No claim of that proof is made.
It remains deferred until an isolated disposable non-production database path
is authorized. All allowed source, unit, architecture, context, type and lint
checks pass without weakening controls, so the scoped source gate passes.

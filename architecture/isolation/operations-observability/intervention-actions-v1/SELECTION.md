# CRM-ARCH-007R intervention-actions repository selection

Status: `PASS_CONTINUE_SOURCE_GATE`

Base commit: `e8811394458d2ee7e731aa51f5ff00c65d958901`

Source commit: `fb53587e5377c272fefa58c58d521c8524a8e511`

Selected the Architecture Lead's accepted D3 relocation of the complete
`intervention_actions` repository boundary from Analytics Reporting to
Operations Observability. The slice includes the three-statement compatibility
DDL state machine, four fixed reads, typed create and outcome-update writes,
and the exact public request/result mappings.

Analytics Reporting retains ID generation, comment/score normalization,
outcome cutoff construction, outcome computation, sequential update
orchestration, presentation mapping, aggregation, labels, rounding and fallback
behavior. Operations Observability exposes only fixed, versioned repository
operations; no request accepts SQL, table names, arbitrary predicates, generic
patches, ordering, pagination or transaction capability.

The five planned write retirements are:

- `arch_88826812df7607334fe418c0` — compatibility table DDL;
- `arch_797839b976905d3a7fc723b8` — compatibility column DDL;
- `arch_b6c2382b10f9b0d97aab482a` — compatibility index DDL;
- `arch_be72e901fee4b2693481ee1d` — intervention action create;
- `arch_e6b0081069429a87f802c5e8` — intervention outcome update.

The direct dependency `analytics_reporting -> operations_observability.public`
is part of the accepted topology. The module-policy amendment is active and the
effective graph contains 967 files, 16 contexts, 106 dependency relationships,
one added slice edge and zero cycles. Strict enforcement records 1,414 findings
and matching exceptions: the exact five planned fingerprints retired, no
finding was added and no shared registry entry changed. Registry regeneration
is deterministic and all 115 cumulative architecture controls pass.

This is a source-only gate. Policy and registry source files changed as part of
enforcement activation, but no database, repository runtime, service,
deployment, production or secret-bearing path was touched. Final `SHA256SUMS`
covers 29 evidence, source and control files and passes 29/29.

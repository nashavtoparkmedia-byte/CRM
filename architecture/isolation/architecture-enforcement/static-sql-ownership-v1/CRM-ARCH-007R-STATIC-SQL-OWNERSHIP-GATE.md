# CRM-ARCH-007R Static SQL ownership gate

Status: `PASS_CONTINUE_SOURCE_GATE`.

Twelve false ambiguous-write findings are retired by a fail-closed parser correction. The same correction surfaces 48 previously hidden unsafe or unproven fragment sites, so the corrected population moves from 115 to 103 genuine sites. Raw write fingerprints are named-scope and AST-site-bound, with duplicate-set salting, so even byte-identical sibling retirement cannot transfer exception identity. No CRM runtime source, schema, database, service, provider transport, credential, or production state changed. All 103 remaining direct foreign/fail-closed dynamic writes are explicit and exactly exception-bound.

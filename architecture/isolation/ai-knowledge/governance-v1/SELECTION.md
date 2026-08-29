# CRM-ARCH-007R AI Knowledge governance selection

Status: `PASS_CONTINUE_SOURCE_GATE`

Base evidence commit: `49901fcc2dd528a83c326d4180b4bc13e5129b44`

Source commit: `2dfa7ebe0683a21cb53ff8f5caf59f2562b60de0`

Selected a strict AI Knowledge owner boundary for the complete 13-site
Configuration governance slice. Thirteen closed v1 commands describe only the
existing edit, lifecycle, verification, supersession, conflict, manual-create,
source-disable and reset mutations. Named handlers depend on a narrow
persistence port, and one compatibility adapter binds them to exact static SQL.

Configuration remains the orchestration boundary and owns authorization,
reads, guards, snapshots, audits, counters, action return values and
revalidation. AI Knowledge owns only item persistence. The existing
`configuration -> ai_knowledge.public` dependency is reused, so the amendment
adds exactly 13 commands and no dependency. Trainer verification remains on
its separate pre-existing item-review command.

No transaction was selected because it would change legacy behavior. Conflict,
manual-create, source-disable and reset remain deliberately sequential and
partially successful on later failure. The adapter avoids dynamic SQL with 15
fixed edit masks and 12 fixed non-edit statements, while exposing no generic
persistence capability.

Strict findings decrease 1,361 to 1,348. Exactly 13 reviewed fingerprints
retire, with zero additions, zero dependency additions and zero cycles. This
selection was validated only through source analysis and offline tests; no
database, runtime, provider, production or secret-bearing path was used.

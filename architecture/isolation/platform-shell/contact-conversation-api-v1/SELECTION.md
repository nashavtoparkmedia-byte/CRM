# CRM-ARCH-007R contact-conversation API selection

Status: `PASS_CONTINUE_SOURCE_GATE`

Base commit: `23ad1aac6569ec329c75b3f8ae3b892c20160123`

Source commit: `8c9f995d91d41810a1420f79bd21caf71ff50a46`

Selected the next accepted low-risk topology slice: classify only the two
contact-conversation HTTP endpoints as Platform Shell orchestration and move
their owner operations behind strict Contacts, Fleet Operations and Messaging
v1 surfaces. The URLs, validation bodies and statuses, log prefixes, response
projections, lookup order, missing-only link backfill and inherited error
visibility remain frozen.

The two routes no longer access Prisma or `ContactService`. Platform Shell
performs Contacts -> Messaging -> conditional Fleet -> Messaging fallback in
the original sequential, non-transactional order. No dependency amendment is
needed because all three owner dependencies already exist.

Strict findings decrease 1,381->1,375: four foreign Chat writes and the two
obsolete consequences of classifying `phoneUtils` as foreign retire. There are
zero additions and zero semantic changes among shared entries.

This is a source-only gate verified by offline analysis and isolated unit
tests. No database, provider, webhook, deployed application runtime, service,
deployment, production or secret-bearing path was accessed or mutated.

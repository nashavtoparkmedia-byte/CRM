# CRM-ARCH-007R conversation contact-link selection

Status: `PASS_CONTINUE_SOURCE_GATE`

Base commit: `9765eb7202bfe07aa54e137d5e96c8d728c0372f`

Source commit: `3c59b2733a6032a7cb1f02be3c42af8a13a0f3ab`

Selected the smallest accepted low-risk topology slice: relocate the single
foreign `Chat.update` in `ContactService.ensureChatLinked` to the Messaging
owner and migrate all twelve callers across the exact seven existing
consumers to one strict versioned public command.

The owner adapter retains the ordered Chat, Contact and Driver reads, optional
driver enrichment, unconditional final Chat update and direct failure
visibility. Consumers retain contact-resolution order and their inherited
catch/swallow boundaries. Contacts acquires no reverse dependency.

The only retired strict finding is
`arch_3a32113e59d6d5250460be8d`. Strict enforcement moves from 1,408 to
1,407 findings and from 85 to 84 direct foreign writes, with zero additions,
zero changed shared entries, zero effective dependency edges and zero cycles.

This is a source-only gate. No database, webhook, provider, service, runtime,
deployment, production or secret-bearing path was accessed or mutated.

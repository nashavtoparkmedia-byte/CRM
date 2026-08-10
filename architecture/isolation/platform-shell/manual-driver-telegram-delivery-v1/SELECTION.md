# CRM-ARCH-007R manual driver Telegram delivery selection

Status: `PASS_CONTINUE_SOURCE_GATE`

Base commit: `4d27223b6950c0c824e762675fe2af960d69f0f7`

Source commit: `144cb01fafb1c98dc9f9cf5ac07d6fa8273969ac`

Selected the next accepted low-risk topology slice: move the existing manual
driver Telegram link and unlink delivery out of the Fleet UI action and into
Platform Shell orchestration over three narrow Telegram Channel v1 commands.
The live URL crossing is same-origin, JSON-only and preserves the UI strings,
input filtering, persistence shapes, notification ordering, error mapping and
conditional refresh behavior.

The legacy Server Action is retired. Platform Shell contains no Prisma or bot
transport access; Telegram Channel owns both `DriverTelegram` persistence and
the optional bot notification adapter. The existing page read remains
caller-owned and byte-identical. No dependency amendment is needed because the
Platform Shell to Telegram Channel public dependency already exists.

Strict findings decrease 1,375->1,373: exactly the legacy
`DriverTelegram.upsert` and `DriverTelegram.delete` foreign writes retire.
There are zero additions and zero semantic changes among shared entries.

This is a source-only gate verified by offline analysis and isolated unit
tests. No database, provider, webhook, deployed application runtime, service,
deployment, production or secret-bearing path was accessed or mutated.

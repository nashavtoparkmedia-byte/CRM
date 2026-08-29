# CRM-ARCH-003 Context Decisions

## Final context set

The architecture uses 16 contexts: Platform Shell; Identity and Access;
Contacts; Fleet Operations; Work Management; Messaging; Telegram Channel; MAX
Channel; WhatsApp Channel; Avito Acquisition; Calling and Telephony; AI
Knowledge; Configuration; Operations and Observability; Analytics and
Reporting; and Edge Delivery.

Provider runtimes are adapters around channel-neutral domain contracts. They
remain separate because their credentials, session state, operational
lifecycle and protected runtime lineages differ. Messaging owns Chat/Message
state; channel contexts own provider-local sessions and identities. Contacts
owns canonical people. Fleet owns Driver/Yandex/YFS state. Calls owns the call
lifecycle and telephony runtime; AI Knowledge owns retrieval and proposal data.

## Ownership and migration

All 96 schema-scoped and raw-only data candidates are assigned exactly once.
The 178 technical-module foreign writes, two legacy writes and 15 formerly
ambiguous raw writes map to 79 compatibility-first migration plans covering
195/195 exact sites.

Targeted inspection resolved every variable-built raw write:

- intervention, integrity, cron, performance, stability and health tables are
  owned by Operations and Observability;
- `config_change_log` is owned by Configuration;
- dynamic retention cleanup is explicitly split between Fleet Operations and
  Messaging;
- the Contacts cleanup spans Contacts and Messaging and therefore remains a
  split owner-command migration.

No `unresolved_raw_scope` remains. Same-context cross-module writes target an
internal owner service; cross-context writes target a public owner command.

## Dependency policy

The desired allowed-dependency graph is acyclic. Of 106 current cross-context
module relationships, 38 point toward an allowed target but still require a
public surface; 68 are forbidden target relationships with explicit transition
instructions. Existing coupling is migration evidence, not authorization.

Cross-cutting observability consumes events/telemetry rather than importing
business internals. Configuration submits owner commands rather than becoming
the owner of provider or AI data. Platform Shell may compose public surfaces,
but domain contexts may not depend back on the shell.

## Compatibility policy

Every context is protected. Existing production entry points, provider
sessions, queues, public paths and runtime topology stay behind compatibility
facades until contract parity is proven. No database split, destructive schema
cutover, provider rewrite or production activation is part of CRM-ARCH-003.

Rejected alternatives are recorded in `context-decisions.json`: folder-per-
context, one provider-heavy Messaging context, and immediate physical database
separation.

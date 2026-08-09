# CRM-ARCH-002 Targeted Code Inspection

## Evidence coverage

Static analysis covers 845 checksummed source, schema, migration and runtime
configuration files (158,155 lines) across 27 technical modules. It resolves
2,639 direct imports: 1,553 internal, 760 internal cross-module, 1,086
external, and zero unresolved internal imports. Literal dynamic imports are
included; inspection found no production computed import/require target.

Prisma inspection records 656 reads and 433 writes. The writes classify as:

- 238 `OWNER`;
- 178 `FOREIGN`;
- 2 `LEGACY`;
- 15 `SHARED_AMBIGUOUS`.

All 96 schema-scoped/current raw-table ownership candidates resolve. The
`usage_events` table, which exists in a migration and is written through raw
SQL but is absent from the current Prisma model surface, is explicitly owned
by Tasks rather than hidden.

## Material coupling findings

The Gravity Prisma singleton is imported by 169 files across 17 modules. It is
the dominant shared infrastructure hotspot and explains why module boundaries
currently do not constrain writes.

The largest foreign-writer modules are Settings (37 sites), Gravity Core (31),
WhatsApp provider (18), Yandex Fleet (15), Contacts (13), MAX provider (11)
and Messages (11). The most frequently foreign-written models are Chat (32),
Message (18), AiKnowledgeItem (15), Contact (11), DriverTelegram (10) and
HistoryImportJob (10). These are direct migration inputs for CRM-ARCH-003;
they are not treated as already-correct ownership.

There are three exact file-level strongly connected components:

1. Messages hooks ↔ message utilities.
2. Telegram actions → message events → pipeline registry/worker/response →
   WhatsApp service → Telegram actions.
3. AI Knowledge Retriever ↔ reranker.

At module level, 17 Gravity modules form one strongly connected component.
This is a concrete monolith-coupling result, not a naming observation.

Three BullMQ topologies have complete producer/declaration/consumer evidence:
`call-transcribe`, `call-analyze`, and YFS `check-history`. The runtime map also
records 199 API routes, 255 worker/cron/timer interactions, 207 queue/event
relationships and 299 literal/environment runtime couplings.

Provider impact is explicit for Telegram, MAX, WhatsApp, Yandex Fleet, Avito,
FreeSWITCH, OpenAI, Anthropic and AWS S3. Credential evidence contains 340
environment access sites (66 credential-like names) and 115 accesses to
credential-bearing database models. It contains names and locations only;
values are never read or emitted.

## Targeted raw-SQL inspection

The 15 ambiguous writes are retained because the call uses variable-built SQL,
an unmodeled table, or more than one ownership domain. Examples include
dynamic retention cleanup, runtime DDL guards, and a Contacts cleanup that
deletes ContactIdentity rows based on Chat references. Assigning these to one
owner automatically would conceal the exact boundary problem.

## Classified limitations

- Static analysis proves structural reachability, not which conditional branch
  executes in a particular production request.
- Provider indicators are an impact map; an indicator is not automatically a
  provider API call. Every file/indicator record remains available for the
  next context decision.
- Dynamic raw-SQL table variables remain `SHARED_AMBIGUOUS` instead of being
  inferred from comments or caller names.

These limitations do not materially change bounded-context or ownership
decisions: exact files, modules, import edges, write sites and unresolved raw
boundaries are present and checksummed.

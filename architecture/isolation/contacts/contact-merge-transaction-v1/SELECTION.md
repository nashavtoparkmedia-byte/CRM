# CRM-ARCH-007R contact-merge transaction selection

Status: `PASS_CONTINUE_SOURCE_GATE`

Base commit: `78097c58e99de2abd2983557c61bb72c2e6381b6`

Source commit: `51e4734d781d7d998f3beba393e397c125c72ef2`

Selected the accepted D2 topology for the existing contact-merge workflow: a
strict `contacts.MergeContactsCommand.v1` owner handler coordinated by a
Contacts unit of work whose callback exposes only named Contacts, Fleet,
Messaging and Work repository methods. One exact legacy Prisma adapter binds
those methods to the same transaction. It does not expose a Prisma client,
transaction client, delegate, SQL fragment, table/model selector, arbitrary
predicate or arbitrary persistence data through the command or repository
ports.

`ContactMergeService` remains as the byte-compatible runtime facade used by
the two unchanged API routes. The protected Messages drawer remains
byte-identical. Contacts retains its own aggregate mutations and ordered lock;
Messaging retains the exact Chat semantics through four named operations;
Work Management retains the exact Task move; Fleet is read-only. The policy
permits exactly the `Chat` and `Task` writer models in the one adapter file.
No `Message` writer, directory-wide exception, dependency edge or manifest
amendment was added. The Contacts manifest already declared
`MergeContactsCommand.v1`.

Strict findings decrease 1,369->1,361. Exactly the eight legacy
`ContactMergeService` foreign-write fingerprints retire, with zero additions,
zero semantic shared-entry changes and zero location-only rebases.

The source-only rollback proof uses deterministic fake transaction staging and
failure injection at every characterized workflow step. It proves callback
failure prevents fake commit and success logging. A physical PostgreSQL
rollback/locking/FK proof is explicitly deferred because database and runtime
paths are closed for this gate. No database, provider, webhook, deployed
application runtime, service, deployment, production or secret-bearing path
was accessed or mutated.

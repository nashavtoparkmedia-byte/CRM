# CRM-ARCH-007R contact-merge transaction source gate

Status: `PASS_CONTINUE_SOURCE_GATE`

The source tip at `51e4734d781d7d998f3beba393e397c125c72ef2`
implements the accepted named-repository D2 unit of work on base
`78097c58e99de2abd2983557c61bb72c2e6381b6`.

`contacts.MergeContactsCommand.v1` now owns legacy contact merge behavior.
`ContactMergeService` is a compatibility-only facade for the two unchanged API
routes. A single Contacts adapter binds exact named owner operations to the
same transaction: default options for simple link and a 15-second timeout for
full merge. Its policy approval is exactly Chat and Task in that file; it has
no Message writer or generic transaction/persistence port. The Contacts
manifest already declared the command, so no manifest or dependency amendment
was added. The effective graph remains 106 observed relationships and zero
cycles.

Strict enforcement passes across 1,007 files and 16 contexts with 1,361
matching findings/exceptions: 66 foreign writes, 38 provider accesses, 374
internal imports, 530 non-public imports and 353 undeclared dependencies. The
exact delta is eight removals, zero additions, zero shared semantic changes and
zero location-only rebases. The deterministic finding digest and registry are
checksummed.

Transaction coordinator 10/10, focused Vitest 61/61, parser 29/29, contract
131/131, context validation and cumulative architecture 130/130 controls pass.
TypeScript retains 28 inherited diagnostics, no slice diagnostic and the
unchanged normalized site/code hash
`2d3847300874a4cc5b419e22e9b1d4b53dc9d3d56a9576f49f2ec37b32db5245`.
All eight changed application source/test files are ESLint-clean.

The 61 focused tests include 35 source-only fake transaction failure-injection
cases. They prove no fake commit or success log after callback failure. They do
not prove real PostgreSQL rollback, locking, constraints or timeout; physical
database validation is explicitly deferred because database and runtime paths
are closed. No database, provider, webhook, deployed runtime, service,
deployment, production or secret-bearing path was accessed or mutated. The
delegated technical source gate passes with that boundary recorded.

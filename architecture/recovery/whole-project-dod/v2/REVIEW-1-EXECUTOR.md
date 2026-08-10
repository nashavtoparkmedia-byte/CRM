# Truthful analyzer and credential-baseline phase — executor review

Verdict: `PASS_PHASE_SCOPE`

Reviewed source commit: `3339325fea53d671008d580e17939d8f72a4602b`

Reviewed source tree: `68e1ccc8f27a96a06ea126bdf83ea8584d39707f`

The earlier 103-site denominator and repository-wide `foreign writes = 0`
interpretation remain superseded. A clean detached checkout of the reviewed
commit contains 1,615 tracked executable surfaces and yields 1,572 write sites:
420 owner, 47 foreign, 634 ambiguous, 468 migration-only and three test sites.
The inventory includes 482 operational-script writes and 918 raw-SQL sites.
There are no parse findings. These non-zero debts are intentionally retained;
this phase proves truthful discovery, not ownership closure.

The AST analyzer covers direct and cast Prisma delegates, aliases,
destructuring, helper/transaction clients, optional chains, dynamic delegates,
Drizzle and generic SQL drivers. Raw analysis retains statement-scoped DML,
relevant DDL, stored-routine bodies, dialect-specific quoting, return/source
dependencies and unresolved dynamic intent. Shell, Python, PowerShell and batch
database sinks are found only at executable command/database receivers; quoted
logs and comments do not manufacture sites. Dynamic identities fail closed and
computed literals are hashed instead of serialized.

The credential inventory records 509 structural accesses: 245 reads, 102
credential-record writes and 162 unresolved fail-closed accesses. It identifies
201 secret-field reads, 44 metadata-only reads, 55 direct foreign accesses and
229 possible public-boundary risks. Credential models and relation targets are
resolved from the three active Prisma schemas; Prisma `_count` projections are
correctly excluded because they reveal cardinality, not related rows or fields.
Outputs contain only structural names, hashes and locations—never source
excerpts or credential values.

All shipped suites pass under the pinned runtime: 71/71 write/SQL cases plus
repository mixed-language, tracked-surface, credential-analyzer and whole-repo
credential-inventory tests. Duplicate write identity keys and duplicate
credential canonical keys are both zero. Marker/secret scans find no serialized
values or absolute repository paths.

The complete write and credential baselines were regenerated from two clean
detached worktrees at different absolute paths under Node v22.18.0 and
TypeScript 5.9.3. Both pairs are byte-identical. Runtime, dependency, analyzer,
source, tree, output and semantic-analysis hashes are sealed in
`ANALYZER_PHASE_IDENTITY.json`.

This is deliberately a phase gate, not architecture completion. The 418
unreviewed operational surfaces, 47 foreign writes, 634 ambiguous writes, 55
foreign credential accesses and 162 unresolved credential accesses remain live
migration work. No production, database, service, protected worktree or
historical evidence mutation occurred. The prohibited legacy evidence validator
was not executed.

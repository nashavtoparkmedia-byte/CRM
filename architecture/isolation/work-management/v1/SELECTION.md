# CRM-ARCH-007 Work Management slice selection

Selected plan: `migration_7f387b2b1d46c88f`, the single Analytics Reporting
foreign `Task.update` in `reassignTasks`. Work Management is protected, so this
slice changes only its public v1 boundary and a compatibility adapter. The
existing task-event service and Prisma schema remain byte-identical.

This is the safest next write-isolation slice because:

- the plan contains one bounded write site and one representative consumer;
- `AssignTaskCommand.v1` is already declared by the accepted Work Management
  manifest;
- the operation has explicit `not_found`, `unchanged`, and `reassigned`
  outcomes that can be verified without a database;
- no provider, credential, queue, schema, Messages, AI Calls, or runtime path is
  involved;
- rollback is the exact source base
  `f77a797b459986ea1b84a8fd9db8261e3b25a814`.

Alternatives were rejected for this slice: RetentionCleanup uses destructive
raw SQL, Messaging touches the protected inbox, and ContactMerge performs two
bulk updates. Production deployment is outside this source gate.

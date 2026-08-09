# CRM-ARCH-007 Work Management inbox slice selection

Selected plan: `migration_6f85afe6aae4abca`, the single Messaging foreign
`ManagerTask.update` in `resolveTask`. Messaging already has an allowed
dependency on `work_management.public`, and `CompleteTaskCommand.v1` is already
declared in the accepted Work Management manifest.

The slice is bounded to one server action, one versioned command/handler and one
owner compatibility adapter. It changes no message timeline, provider,
credential, schema, queue, read model or runtime path. `done` and `skipped`, the
legacy `manager` resolver marker, timestamp creation, error propagation and
post-success `/inbox` revalidation remain explicit. Rollback is the exact base
`5d6116a495bfca65a95c1caaae65eff92e701ab4`.

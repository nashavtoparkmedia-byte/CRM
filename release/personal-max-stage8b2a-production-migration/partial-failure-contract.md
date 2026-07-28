# Partial failure contract

Any nonzero migration runner exit stops the action. Diagnostics are sanitized and mark deploy blocked. The fresh backup is preserved. The operator must not drop tables, delete or edit `_prisma_migrations`, use `migrate resolve`, or attempt a destructive rollback. Applied names must be read during the later incident review before any next action.

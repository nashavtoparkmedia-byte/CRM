# CRM-ARCH-007 Messaging communication-triggers selection

Selected complete 4/4 plan `migration_32c0e2377e609527`. Messaging gains
create, update and delete commands; toggle reuses update. The already accepted
acyclic `configuration -> messaging.public` dependency is reused. Trigger reads
and success-only revalidation remain Configuration orchestration. No server
action or trigger executed.

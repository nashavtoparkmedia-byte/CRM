# CRM-ARCH-007 Messaging MAX Message selection

Selected complete 3/3 plan `migration_a5a1040630dc288c`. Messaging gains
provider-neutral delete, replace-external and upsert-external commands. The
pre-approved acyclic `max_channel -> messaging.public` dependency is reused.
MAX parsing, DOM matching, workflow, attachments, contact resolution, shadow
compare and emit remain caller orchestration. No webhook or transport ran.

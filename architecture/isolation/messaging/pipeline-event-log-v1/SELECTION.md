# CRM-ARCH-007 Messaging pipeline event-log selection

Selected complete 3/3 plan `migration_b13277983c0d719d`. Messaging gains
atomic claim, complete and fail commands for MessageEventLog. The pre-approved
acyclic `platform_shell -> messaging.public` dependency is reused. AI
orchestration, aiStatus transitions, logging and tolerant recovery remain in
PipelineWorker. No pipeline or model call ran.

# CRM-ARCH-007 Messaging Avito Chat selection

Selected complete 3/3 plan `migration_08ae2450b82ef247`. Messaging gains an
idempotent lead-conversation ensure command and a processed-conversation resolve
command. The pre-approved acyclic `avito_acquisition -> messaging.public`
dependency is reused. Avito auth, response persistence, Contact resolution,
Message receive and HTTP acknowledgement remain caller orchestration. No
webhook or transport ran.

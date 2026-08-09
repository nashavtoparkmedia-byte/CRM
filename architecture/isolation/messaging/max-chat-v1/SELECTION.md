# CRM-ARCH-007 Messaging MAX Chat selection

Selected complete 5/5 plan `migration_891ed67c317c43a7`. Messaging gains
provider-neutral patch and create external-conversation commands. The
pre-approved acyclic `max_channel -> messaging.public` dependency is reused.
MAX identity matching, history semantics, Contact orchestration, shadow compare,
Message/media handling and broadcast remain caller orchestration. No webhook or
transport ran.

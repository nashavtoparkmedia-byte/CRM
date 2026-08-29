# CRM-ARCH-007 AI Knowledge Proposed Reply selection

Selected complete 6/6 plan `migration_e49c8cabc83892c7`. AI Knowledge gains
narrow proposal upsert and lifecycle patch commands through the existing
acyclic `messaging -> ai_knowledge.public` dependency. Messaging retains all
reads, generation, feature decisions, trainer/coach orchestration and audit.

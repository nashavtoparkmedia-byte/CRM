# CRM-ARCH-007 AI Knowledge usage-log selection

Selected `migration_ca65203b883c6533`, the complete one-site Platform Shell
write to AI-Knowledge-owned `AiKnowledgeUsageLog`. Platform Shell already
depends on `ai_knowledge.public`; this slice adds one explicit command and no
dependency edge.

The caller retains retrieval-policy classification, candidate order, identifier
generation and tolerant per-item error handling. AI Knowledge owns only the
exact persistence mapping and database timestamp. Neighboring
`AiDecisionLog` persistence remains explicitly out of scope. This is source
isolation only; no pipeline, database or production operation was executed.

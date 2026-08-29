# CRM-ARCH-007 Messaging call-timeline selection

Selected complete Message plan `migration_cc4d8c99d5a71ef5` (2/2) and Chat
plan `migration_e3f1d4c8021a234a` (3/3) as one atomic call-timeline slice. The
existing acyclic `calling -> messaging.public` dependency is reused. Calling
retains guards, status/disposition mapping and stream broadcast; Messaging now
owns all idempotent Chat and Message persistence. No call, transport or action
ran.

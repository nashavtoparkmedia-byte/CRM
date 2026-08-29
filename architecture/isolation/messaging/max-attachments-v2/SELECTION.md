# CRM-ARCH-007 Messaging MAX attachments selection

Selected `migration_577f6451590e697c`, the complete two-site MAX Channel plan
for Messaging-owned `MessageAttachment`: delete-all during a confirmed message
deletion and create during attachment ingestion. MAX already depends on
`messaging.public`.

Accepted `AttachMessageMediaCommand.v1` remains byte-identical because its
non-null byte-size contract matches WhatsApp but not MAX's legacy nullable
size. A coexisting v2 expresses nullable size, and a separate
`DeleteMessageMediaCommand.v1` expresses deletion. This makes both semantics
explicit without silently broadening v1. Other MAX Message and Chat writes stay
direct and exceptioned.

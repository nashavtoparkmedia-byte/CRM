# CRM-ARCH-007 Messaging WhatsApp attachment selection

Selected `migration_f2e2a093cfd6bc54`, the complete one-site WhatsApp Channel
write to Messaging-owned `MessageAttachment`. `AttachMessageMediaCommand.v1`
was already declared by Messaging and WhatsApp already depended on
`messaging.public`, so this slice adds no manifest capability or graph edge.

WhatsApp retains provider download, size enforcement, data-URL construction,
nullable filename/MIME coercion, logging and nonfatal error handling. Messaging
owns the exact attachment persistence mapping. Other WhatsApp Chat, Message and
history-import writes remain direct and out of this one-site gate.

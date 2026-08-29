# CRM-ARCH-007 Messaging lead-receive selection

Selected `migration_ddfe2f0b09f6ba87`, the complete one-site Avito Acquisition
write to Messaging-owned `Message`. Both `ReceiveMessageCommand.v1` and the
Avito-to-Messaging dependency were already declared in accepted context
manifests, so this slice adds no graph edge or manifest capability.

Messaging now owns external-id idempotency and the fixed inbound/text/delivered
persistence. Avito retains source-derived content, channel, timestamp and
metadata. The neighboring three-site Chat create/update plan stays direct and
exceptioned; it is not folded into this one-site gate.

# CRM-ARCH-007 Messaging bot system-send selection

Selected `migration_e8090a3214acadc2`, the complete one-site Platform Shell
write to Messaging-owned `Message`. `SendMessageCommand.v1` and the
Platform-Shell-to-Messaging public dependency were already declared in the
accepted context manifests, so this slice adds no graph edge or capability.

Messaging now owns the fixed system/system/sent persistence fields. The bot
retains chat lookup, notification text, Telegram channel, external-id and
timestamp construction, ordering and nonblocking error boundary. The adjacent
`Chat.update` plan `migration_d1f7fa71cd1fca3c` remains direct, exceptioned and
out of this one-site gate.

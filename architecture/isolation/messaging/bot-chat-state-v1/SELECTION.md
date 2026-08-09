# CRM-ARCH-007 Messaging bot chat-state selection

Selected the executable production site in `migration_d1f7fa71cd1fca3c`:
Platform Shell's bot `Chat.update` immediately after its accepted system
notification. Platform Shell already depends on `messaging.public`; the slice
adds only `UpdateConversationCommand.v1` to Messaging's effective manifest.

The historical plan reports two sites. Its second entry is a test-role string
assertion in `max-contact-resolution-shadow.test.ts` that reads a different MAX
route and searches for the text `prisma.chat.update`; it is not an executable
write and is deliberately preserved. Thus the executable production scope is
closed 1/1 and the complete two-entry inventory is adjudicated 2/2 without
misrepresenting test source as persistence.

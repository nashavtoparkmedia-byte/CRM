# CRM-ARCH-007 Contacts / MAX display-name slice selection

Selected plan: `migration_22eff9f42e71a832`, the single MAX Channel foreign
`Contact.update` in the sync-names route. MAX already has an allowed dependency
on `contacts.public`, and `ResolveContactCommand.v1` is already declared by the
Contacts manifest.

The bounded operation promotes a useful candidate display name only when the
current Contacts-owned name is a legacy placeholder. MAX normalization and
useful-name screening remain in the caller. MAX transport/session/credentials
and the neighboring Messaging-owned `Chat.update` are deliberately unchanged.
Rollback is exact base `21b047ec8ffb3a73ec82aa35912bd5016c2faf8c`.

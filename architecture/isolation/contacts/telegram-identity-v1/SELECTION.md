# Contacts / Telegram identity slice

Selected `migration_2fa76a81f50975bf` (1/1 `ContactIdentity.update`). Telegram already depends on Contacts and `AttachContactIdentityCommand.v1` is declared. Generic profile fields cross the contract; legacy Telegram metadata keys remain owner-adapter details. No transport, credential, Contact display-name, Message, schema, or runtime mutation is included. Rollback: `b0ef1c270d5b12328308bd1c548c47108a1517ec`.

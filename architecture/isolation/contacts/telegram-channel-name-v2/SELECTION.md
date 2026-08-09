# Contacts / Telegram channel-name v2

Selected `migration_df330f5e98d139d5` (1/1 `Contact.update`). Telegram's channel-authority rule differs from v1 placeholder promotion, so accepted v1 remains byte-identical and coexisting `ResolveContactCommand.v2` is added through a reviewed `add_commands` amendment. No transport, credential, identity-metadata, message, schema, or runtime mutation. Rollback: `cc1259ce201257bb78c1069c136723ca630c13f8`.

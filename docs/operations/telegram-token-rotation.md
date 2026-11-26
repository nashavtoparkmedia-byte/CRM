# Telegram production token preparation and rotation

The driver bot's production credential is **`BOT_TOKEN`**. The production
Compose `tg-bot` service reads it from `deploy/secrets/telegram-bot.env`; the
file is host-owned by the rootless Docker account, mode `0600`, in a mode `0700`
directory. It is ignored by Git. `ALERT_BOT_TOKEN` is used only by
`scripts/deploy.sh`, `scripts/health-monitor.sh`, and `scripts/restore-test.sh`
to send operational notifications. It is not the driver bot token.

## After Owner authorizes rotation

1. Identify and stop the existing polling consumer on the Windows host. Verify
   it is stopped before revoking the compromised token; do not run the new bot
   in parallel with the old consumer.
2. Rotate the token with BotFather. Do not paste it into chat, a shell command,
   a command argument, Git, or a terminal transcript.
3. On Ubuntu, from the CRM checkout, run `scripts/install-telegram-token.sh`.
   Paste the new value at the hidden prompt. The script validates its shape,
   writes atomically with mode `0600`, preserves other entries in the file (such
   as the private Xray proxy credentials), and never prints the token. It rejects
   missing or malformed input.
4. Run `node scripts/verify-yoko-park-token.js`. It calls Telegram `getMe`
   over verified HTTPS and prints only whether the username is exactly
   `@yoko_park_bot`; it never prints the token or response body.
5. Before consumer start, confirm `crm-tg-bot` is absent/stopped. Start exactly
   one `tg-bot` service only after the separate Owner production GO, then verify
   its PostgreSQL advisory singleton lock is held. On duplicate lock refusal,
   do not start another instance.
6. Confirm polling is selected (`BOT_UPDATE_MODE=polling`), health and mock
   update/CRM registration checks pass, and persisted SQLite/CRM state remains
   present after a controlled restart. Never enable compensation/referral
   financial functions as part of token rotation.

The token file is read by Compose as an env file for `tg-bot` only. The bot
still receives `BOT_TOKEN` as an environment variable, as required by its
current startup config. Compose/container inspection is privileged to the
rootless Docker account; protect that account and do not print container
environment output.

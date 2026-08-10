# TG-Bot-1

## Security-sensitive runtime configuration

The admin backend and frontend require explicit `ADMIN_USER` and `ADMIN_PASS`
values. There are no built-in credentials. The browser exchanges those values
once at `/api/auth/login`; subsequent requests use a signed, HttpOnly,
SameSite session cookie. `ADMIN_SESSION_SECRET` may be set to rotate session
signing independently; an explicitly configured value must contain at least
32 characters and must not be a placeholder. If it is omitted, the existing
`ADMIN_PASS` is used as the signing key. Never place admin credentials in query
strings or URL hashes.

Production currently runs Telegram through long polling. If webhook delivery
is enabled, use `POST /api/webhooks/telegram/:botId` and configure
`TELEGRAM_WEBHOOK_SECRET` both here and as Telegram's `secret_token`. The old
token-in-path route is disabled unless `ALLOW_LEGACY_WEBHOOK_PATH=true`; that
migration lane still requires the secret header and should be removed from
Telegram configuration as soon as the webhook URL is updated.

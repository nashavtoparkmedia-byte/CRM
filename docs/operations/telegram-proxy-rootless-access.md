# Telegram API egress from rootless Docker

## Decision

Keep `tg-bot` in the existing rootless Docker Compose project and add a second,
authenticated HTTP inbound to the existing Xray process. Do not change the
current Xray listener on `127.0.0.1:10809`. Bind the additional listener only to
Ubuntu's private LAN address `192.168.0.102:10810`. Do not add a router
forwarding rule for that port.

RootlessKit currently starts with `--disable-host-loopback`; `host.docker.internal`
does not make the host's loopback listener reachable. A one-off container
confirmed that both `10.0.2.2:10809` and the gateway's `172.18.0.1:10809` are
unreachable. A LAN-bound probe was reachable from the rootless bridge, so the
private host address is the usable path. The probe listener was closed after
the test.

| Concern | A: rootless Docker + authenticated Xray inbound | B: bot under `systemd --user` |
| --- | --- | --- |
| Complexity | One extra Xray inbound and bot-only proxy credentials | Change deployment ownership, publish loopback DB/CRM ports, reconfigure CRM endpoint and bot API consumers |
| Security | No Docker daemon change; Xray keeps its loopback listener and adds only an authenticated listener on the private LAN IP | Host process can use Xray loopback, but bot API must be reachable by the Docker frontend/Nginx; additional host ports and service boundary |
| CRM/PostgreSQL | Existing Compose DNS and private network remain unchanged | Requires host access endpoints for PostgreSQL and CRM; other Docker services still need bot API access |
| SQLite | The configured Compose `tg_bot_data` named volume stays the sole bot runtime store | The current rootless test volume is owned by mapped UID 100998 with mode 0700; host `yoko` cannot use it directly. Ownership/path changes would be needed to avoid a second SQLite store |
| Autostart | Existing Compose `restart: unless-stopped` | User manager and linger are available, but this adds a second deployment/lifecycle path |
| Backup | Existing named-volume backup remains authoritative | Backup/restore path must be changed to the host service's data directory |
| Support cost | Keep existing deployment and service topology | Maintain systemd unit, host networking, Docker-to-host bot API routing, and SQLite ownership |

Option A is the smaller change and leaves production data paths intact. This is
an additional inbound in the existing Xray service, not another proxy process.
The HTTP proxy user and password must be random, unique, and stored only in
`deploy/secrets/telegram-bot.env` (mode `0600`). Use these variable names:

```dotenv
TELEGRAM_HTTP_PROXY=http://192.168.0.102:10810
TELEGRAM_HTTP_PROXY_USER=<random-local-user>
TELEGRAM_HTTP_PROXY_PASSWORD=<random-local-password>
```

Add a unique inbound under the existing Xray `inbounds` array. Preserve the
current inbound and all routing/outbound entries:

```json
{
  "listen": "192.168.0.102",
  "port": 10810,
  "protocol": "http",
  "tag": "yoko-tg-bot-private",
  "settings": {
    "users": [{ "user": "<same-random-local-user>", "pass": "<same-random-local-password>" }],
    "allowTransparent": false
  }
}
```

The installed Xray is `26.11.9`; its HTTP inbound uses the `settings.users`
array for Basic authentication. Do not reuse the driver bot token or any other
credential. Basic authentication is for this private host path only; never
forward port `10810` through Cudy/TP-Link or expose it on a public interface.

## Owner operation requiring sudo

```bash
sudoedit /usr/local/etc/xray/config.json
```

This opens the root-owned Xray config without printing its contents. Add the
inbound above, using one locally generated credential pair in both the Xray
config and the protected bot env file. Then validate the config and restart the
existing service:

```bash
sudo /usr/local/bin/xray run -test -config /usr/local/etc/xray/config.json
sudo systemctl restart xray.service
```

The restart briefly interrupts processes using Xray. It does not restart Docker,
Preview, CRM, or PostgreSQL. If validation fails, do not restart Xray. After
restart, confirm listeners are exactly `127.0.0.1:10809` and
`192.168.0.102:10810`; confirm no router forwarding rule exists for `10810`.

## Verification after the Owner operation

1. Rebuild the candidate `tg-bot` image from its lockfile.
2. Run a one-shot container on `crm_internal` with the bot's env files, overriding
   the entrypoint with a Node HTTPS GET to `https://api.telegram.org/`. It must
   return the unauthenticated API root's HTTP redirect, without using `BOT_TOKEN`
   or starting polling.
3. Restart that one-shot container and repeat the request.
4. Confirm `crm_internal` requests still use `http://gravity-mvp:3002` and
   PostgreSQL still uses the Compose service name `postgres`; no generic
   `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` is set.
5. Remove the one-shot container. Do not start the production polling consumer
   as part of this connectivity check.

Until the authenticated Xray inbound is added and those container checks pass,
Telegram API connectivity from the bot runtime remains **BLOCKED**.

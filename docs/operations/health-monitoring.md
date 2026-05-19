# Health monitoring — operational bridge for `/api/health/infra`

This document is the minimal practical wire-up between the
`/api/health/infra` endpoint that ships in CRM and the external
monitor / cron / Task-Scheduler that should be alerting an operator
when something is wrong.

It is intentionally **not** a monitoring platform. There is no
alerting framework here, no Prometheus, no metrics database — just
the contract, two tiny scripts (`scripts/check_health.sh`,
`scripts/check_health.ps1`) and four monitor-backend recipes you can
copy/paste.

---

## Endpoint contract

```
GET /api/health/infra
```

- **Public** — bypasses auth by design. Any future security-hardening
  PR (signed cookies / middleware / real auth) must keep this route
  reachable anonymously.
- **`force-dynamic`** — never cached, every request runs the four
  probes concurrently with their own timeouts.
- **Per-check timeout** — `HEALTH_CHECK_TIMEOUT_MS` env override on
  the server side, default `2000` ms per dependency.

### Response examples

**`ok`** (HTTP 200):
```json
{
  "status": "ok",
  "ts": "2026-05-19T22:04:31.509Z",
  "checks": [
    { "name": "postgres", "ok": true,  "ms": 31 },
    { "name": "redis",    "ok": true,  "ms": 34 },
    { "name": "minio",    "ok": true,  "ms": 43 },
    { "name": "fs_esl",   "ok": true,  "ms": 31 }
  ]
}
```

**`degraded`** (HTTP 503):
```json
{
  "status": "degraded",
  "ts": "2026-05-19T22:10:00.000Z",
  "checks": [
    { "name": "postgres", "ok": true,  "ms": 28 },
    { "name": "redis",    "ok": false, "ms": 2001, "error": "timeout" },
    { "name": "minio",    "ok": true,  "ms": 41 },
    { "name": "fs_esl",   "ok": true,  "ms": 19 }
  ]
}
```

**`down`** (HTTP 503):
```json
{
  "status": "down",
  "ts": "2026-05-19T22:11:00.000Z",
  "checks": [
    { "name": "postgres", "ok": false, "ms": 2001, "error": "timeout" },
    { "name": "redis",    "ok": false, "ms": 4,    "error": "ECONNREFUSED" },
    { "name": "minio",    "ok": false, "ms": 1500, "error": "NoSuchBucket" },
    { "name": "fs_esl",   "ok": false, "ms": 0,    "error": "ECONNREFUSED" }
  ]
}
```

### HTTP semantics

| Server status | HTTP | Note |
|---|---|---|
| `ok` | **200** | all four dependency probes returned `ok: true` |
| `degraded` | **503** | 1–3 probes failed |
| `down` | **503** | all four probes failed (or empty check set — defence-in-depth) |

A simple status-code monitor (`curl --fail` / k8s readiness probe /
Uptime Kuma «HTTP 200 only» mode) can therefore treat the endpoint
as binary: 200 = green, anything else = trouble. The JSON body lets
the operator dig into *which* dep is down.

---

## Status semantics (incl. monitor's view)

| Status from script | Meaning | Source |
|---|---|---|
| **`ok`** | All four dependencies healthy. | Endpoint returned `status="ok"`. |
| **`degraded`** | Partial infrastructure failure — CRM is up, ≥1 dependency is unreachable / timing out. | Endpoint returned `status="degraded"`. |
| **`down`** | Total infrastructure failure — all four dependencies are unreachable, but the CRM process itself is still serving HTTP. | Endpoint returned `status="down"`. |
| **`unreachable`** | The CRM process itself is unreachable (TCP refused, DNS fail, timeout, HTML error page instead of JSON, …). | curl / Invoke-WebRequest could not parse a valid response. |

`unreachable` is intentionally distinct from `down`: when the CRM
process is dead nothing inside it can tell you so. That's the case
where you need an *external* monitor (separate host) — see recipes
below.

---

## Recommended cadence

| Monitor type | Cadence | Why |
|---|---|---|
| **External monitor** (Uptime Kuma, Pingdom, UptimeRobot, separate VPS) | **60 s** | Standard balance — fast enough to catch trouble inside SLA, slow enough not to spam the endpoint. |
| **Local watchdog** (Docker HEALTHCHECK, k8s probe, systemd timer on the same host) | **10–30 s** | In-process probes are cheap and tightly coupled to restart policy. |

---

## Hysteresis

**Alert only after 3 consecutive failures.** Roughly two minutes of
sustained failure at 60 s cadence.

Reasons:
- **Transient network blips** — a single missed probe is almost always
  a flake, not a real incident. Paging on every single failure burns
  on-call rapidly.
- **Startup / restart windows** — when CRM or Postgres restarts the
  endpoint can briefly return `degraded` while a connection pool warms
  up. Three consecutive failures separate «restart in progress» from
  «something is actually broken».
- **Avoiding flapping** — single-failure alerts pair badly with flaky
  monitors and produce alert noise instead of signal.

For lower-impact dependencies (e.g. MinIO during a planned maintenance
window) consider raising hysteresis to 5 consecutive failures instead
of decreasing cadence.

---

## Runbook

Minimal practical actions. **No enterprise process — just the
shortest path to «is this fixable in 5 minutes or do I escalate».**

### Postgres failed
1. `psql -c "select 1"` from the CRM host. If that fails too — Postgres
   service itself is down. Restart the Postgres process /
   `docker compose up -d postgres` / `systemctl start postgresql`.
2. If `psql` succeeds but the endpoint still shows `postgres: ok=false`
   — check `DATABASE_URL` in `gravity-mvp/.env`. After fixing, **restart
   the CRM process** so Prisma re-creates its pool.
3. Inspect the latest 50 `opsLog` lines in CRM stdout for
   `database_*_failed` events to learn why connections were dropping.

### Redis failed
1. `redis-cli ping` from the CRM host. If `+PONG` doesn't come back —
   restart Redis. On the WSL2 dev stack: see
   `gravity-mvp/scripts/ensure_local_infra.js`.
2. If Redis is reachable from the shell but not from the endpoint —
   check `REDIS_HOST` / `REDIS_PORT` env vars.
3. BullMQ workers depend on Redis. After Redis is back, run
   `STALE_AI_SESSION_DRY_RUN=1 node gravity-mvp/scripts/cleanup_stale_ai_sessions.js`
   to see if any AI-call sessions got orphaned while Redis was down.

### MinIO failed
1. `curl -fsS http://127.0.0.1:9000/minio/health/live` from the CRM host.
2. If MinIO is down — restart it. Recording-upload is the only AI-call
   path that depends on MinIO; calls already in flight will fail to
   persist a recording but the dialog itself continues.
3. Inspect MinIO logs (`/var/log/minio.log` on the WSL2 dev stack) for
   permission / disk-full errors. The default credentials in dev are
   `crmadmin / crmpassword123`.

### FreeSWITCH ESL failed
1. `nc -zv 127.0.0.1 8021` (or `Test-NetConnection -ComputerName
   127.0.0.1 -Port 8021` on Windows). If TCP refused — restart the
   FreeSWITCH process (`systemctl restart freeswitch` /
   `/usr/local/freeswitch/bin/freeswitch -ncwait`).
2. **No live AI-calls will succeed while ESL is unreachable.** Existing
   calls in progress will continue, but `/api/ai-calls/start` will
   fail at originate.
3. Synthetic smoke (`gravity-mvp/scripts/smoke_ai_persistence.js`)
   does NOT exercise ESL, so it will pass even with `fs_esl: ok=false`
   — that's expected; the smoke is a CRM-side recording-pipeline check.

### Endpoint unreachable (script reports `unreachable`)
1. The CRM process itself is down or the port isn't reachable. Restart
   the CRM (`npm run dev` from `gravity-mvp/`, or whatever your prod
   process manager uses).
2. If CRM is up but the route 404s — that build may have shipped
   without `/api/health/infra`. Verify `gravity-mvp/src/app/api/health/infra/route.ts`
   exists in the deployed code.
3. If CRM is up and the route is present but you still get
   `unreachable` from the script — likely an HTTP listener on the
   wrong port. Check `HEALTH_URL` / actual listening port via
   `netstat -ano | findstr :3002`.

---

## Monitoring recipes

Pick one. None of these requires changes to CRM itself — the endpoint
already does its half.

### Uptime Kuma (self-hosted, recommended for production)

1. Add a new **HTTP(s) — Keyword** monitor.
2. URL: `https://your-crm-host/api/health/infra`.
3. Method: GET.
4. **Heartbeat Interval**: 60 s.
5. **Retries** = 3 (hysteresis — see above).
6. **Keyword**: `"status":"ok"` — matches the server-side string in
   the JSON body. Mark as «monitor down when keyword NOT found».
7. Wire up a notification channel (Telegram, Slack, Discord, email)
   in Uptime Kuma's settings.

Result: on first failure Uptime Kuma starts retrying; after 3 misses
in a row (≈2 minutes), it fires the alert.

### Linux cron + scripts/check_health.sh

```cron
# Every minute, run check_health.sh. Cron mails stderr by default;
# the script writes its single-word status to stdout and uses the
# exit code for the actual signal.
* * * * * /opt/crm/scripts/check_health.sh > /var/log/crm-health.log 2>&1
```

For the *alert* side (cron is just polling), pair it with a tiny
wrapper that records the previous status and pages you on transition:

```bash
prev=$(cat /var/run/crm-health.prev 2>/dev/null || echo ok)
now=$(/opt/crm/scripts/check_health.sh)
if [ "$now" != "$prev" ]; then
  # Send your alert here (mail, curl to webhook, whatever).
  echo "CRM health: $prev → $now"
fi
echo "$now" > /var/run/crm-health.prev
```

Cron hysteresis (3 consecutive failures) is easiest on the alert
side: only page if `$now` has been non-`ok` three runs in a row.

### Windows Task Scheduler + scripts/check_health.ps1

1. Open **Task Scheduler** → Create Basic Task.
2. **Trigger**: Daily → recur every 1 minute. (Task Scheduler's
   minimum granularity at the «Basic Task» level is one minute; use
   the Advanced view for 30 s.)
3. **Action**: Start a program.
4. **Program/script**:
   ```
   powershell.exe
   ```
5. **Arguments**:
   ```
   -NoProfile -ExecutionPolicy Bypass -File "C:\crm\scripts\check_health.ps1"
   ```
6. The exit code lands in the Task Scheduler «Last result» column —
   `0x0` = ok, `0x1` = degraded, `0x2` = down, `0x3` = unreachable.

For hysteresis + alerting, the same «record prev / page on change»
pattern as the cron recipe works fine in PowerShell.

### UptimeRobot (SaaS, free tier)

1. Sign in to UptimeRobot.
2. **Add New Monitor** → **HTTP(s)** (or **Keyword**).
3. URL: `https://your-public-crm-host/api/health/infra`.
4. **Monitoring Interval**: 60 s (5 minutes on free tier — acceptable
   for non-critical setups).
5. (Keyword type) Keyword: `"status":"ok"` — alert if not found.
6. Configure email / Telegram / SMS contacts.

Use UptimeRobot when you specifically want monitoring from an
*outside* network — your in-house Uptime Kuma can't tell you if your
hosting provider's network blocks inbound traffic; an external SaaS
can.

---

## Quick check (do this once after every deploy)

```bash
# Linux/macOS
bash scripts/check_health.sh
echo "exit=$?"

# Windows
pwsh scripts/check_health.ps1   # or: powershell.exe -File scripts/check_health.ps1
echo "exit=$LASTEXITCODE"
```

Expected fresh-deploy output:
```
ok
exit=0
```

If you get `unreachable` (exit 3), your CRM process is down. If you
get `degraded` or `down`, follow the runbook above for the failing
dependency.

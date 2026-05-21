# Production deployment — process supervision and runbook

This is the operator's manual for running the AI-call platform in
production. It is intentionally **not** a Kubernetes / Docker-platform
manifesto: pick one of three supervision recipes (systemd / NSSM /
PM2) and the runtime is reproducible on a single Linux or Windows
host. Bigger orchestrators are not required at the current scale and
will be added when scale actually demands them.

The companion artifacts in `deploy/` are paste-ready templates — fill
in paths and env-var values, drop them into the supervisor of your
choice.

---

## 1. Topology

```
         Megafon SBC (SIP/UDP 5060)
                  │
                  ▼
         ┌──────────────────┐
         │   FreeSWITCH     │  inbound SIP + dialplan + mod_audio_fork
         │   :5060 SIP      │
         │   :8021 ESL      │
         │   :3478 STUN     │ (if WebRTC softphones)
         └────────┬─────────┘
                  │ WS audio (mod_audio_fork → bridge :3030)
                  │ ESL events ↔ bridge + CRM
                  ▼
         ┌──────────────────┐
         │   AudioBridge    │  Node, in-memory CallSessions
         │   :3030 WS+HTTP  │  drives STT/LLM/TTS round-trips
         └────────┬─────────┘
                  │ HTTP /api/ai-calls/* (5 s timeouts, finalize-retry)
                  ▼
         ┌──────────────────┐
         │       CRM        │  Next.js, server actions, BullMQ workers
         │   :3002          │  graceful shutdown via SIGTERM
         └────┬────────┬────┘
              │        │
              ▼        ▼
        ┌────────┐  ┌────────┐
        │ Redis  │  │ MinIO  │
        │  :6379 │  │ :9000  │
        │ (queue)│  │ (rec)  │
        └────────┘  └────────┘
```

### What's stateful, what's restartable

| Component | State on disk | Survives restart? | Recovery semantic |
|-----------|---------------|-------------------|-------------------|
| **FreeSWITCH** | dialplan XML, sip_profiles, vars.xml | yes | Caller drops; in-flight calls die. Megafon REGED again ~5–10 s after process up. |
| **AudioBridge** | nothing on disk — in-memory `sessions` Map | **no** | In-flight calls lose dialog state; FS hangs them up. Bridge ready for new calls ~1 s after process up. |
| **CRM** | Prisma Postgres connection, in-process BullMQ workers, OperationalJobs intervals | partial | Graceful SIGTERM closes WA / TG / BullMQ / Prisma in ~10 s. Workers restart on boot via `instrumentation.ts`. |
| **PostgreSQL** | persistent | yes | Recover via own restart (out of scope). |
| **Redis** | BullMQ jobs in-memory (no RDB) | **partial** | Job queue contents lost on Redis restart; BullMQ workers reconnect. In-flight jobs may be re-driven from CRM (e.g. `enqueueAnalyze(callId)`). |
| **MinIO** | persistent (recording MP3s) | yes | Upload retries cover transient blips (PR #54). |
| **`users.json`** | persistent file | yes | Read-mostly; identity registry for 3 users. |

The honest summary: **AudioBridge is the only component where a crash mid-call permanently loses dialog state.** Stale-session reaper (PR #43) sweeps the Call row to `failed` after 30 min; UI accurate within that window.

---

## 2. Process inventory

Five processes for a full stack, in startup order.

| # | Process | Command | Port(s) | Restart on crash? |
|---|---------|---------|---------|-------------------|
| 1 | PostgreSQL | external — `systemctl`, Docker, RDS, etc. | 5432 | yes |
| 2 | Redis | `redis-server` | 6379 | yes |
| 3 | MinIO | `minio server /var/lib/minio-data --console-address :9001` | 9000 / 9001 | yes |
| 4 | FreeSWITCH | `freeswitch -ncwait` | 5060 / 8021 | yes |
| 5 | CRM | `npm start` (or `npm run dev` in dev) in `gravity-mvp/` | 3002 | yes |
| 6 | AudioBridge | `node server.js` in `tools/audio-bridge-day1/` | 3030 | yes |

PostgreSQL is the platform's hard dependency — start it first. The rest can be brought up in any order; each component reconnects to its dependencies with backoff (ESL: PR #51 / #53 era, BullMQ: ioredis built-in, MinIO upload: PR #54 retry).

For local-dev convenience the repo ships `start-all.bat` (Windows) and `gravity-mvp/scripts/ensure_local_infra.js` (Redis + MinIO bootstrap in WSL).

---

## 3. Linux — systemd recipes

Paste-ready templates live in `deploy/systemd/`. After editing paths and env vars:

```bash
sudo cp deploy/systemd/crm.service          /etc/systemd/system/
sudo cp deploy/systemd/audio-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now crm audio-bridge
sudo systemctl status crm audio-bridge
```

### Conventions baked into the templates

- **`Restart=on-failure`** — restart only on non-zero exit. Manual `systemctl stop` doesn't loop the supervisor.
- **`RestartSec=5`** — wait 5 s before respawning, matches the per-process boot time so we don't hot-loop on a config bug.
- **`StartLimitIntervalSec=120` + `StartLimitBurst=5`** — if the service fails 5 times in 2 minutes, systemd gives up. Operator must intervene; auto-restart loops don't hide config errors.
- **`KillSignal=SIGTERM` + `TimeoutStopSec=15`** — sends SIGTERM (which both CRM and bridge handle gracefully, see §6) and gives 15 s for the graceful path before SIGKILL.
- **`EnvironmentFile=`** — secrets and per-environment config in `/etc/crm/crm.env` and `/etc/crm/audio-bridge.env`, NOT committed to the repo. The templates point at standard paths; create the env files with the same shape as `gravity-mvp/.env.example` and `tools/audio-bridge-day1/.env.example`.

### Healthcheck integration

systemd doesn't natively poll an HTTP endpoint. Pair the service with a `systemd.timer` that runs `scripts/check_health.sh` every 60 s (per PR #49). On non-zero exit the timer triggers an alert to operator's notification channel — no auto-restart loop on health-check failure.

---

## 4. Windows — NSSM or Task Scheduler

Pick one based on what's already installed. Both produce the same result: bridge / CRM stay up after window close, restart on crash, write logs to disk.

### NSSM (recommended for production Windows hosts)

Download NSSM from <https://nssm.cc/> and:

```cmd
nssm install AudioBridge "C:\Program Files\nodejs\node.exe" "server.js"
nssm set AudioBridge AppDirectory "D:\Github\CRM\tools\audio-bridge-day1"
nssm set AudioBridge AppEnvironmentExtra "CRM_BASE_URL=http://127.0.0.1:3002"
nssm set AudioBridge AppStdout "D:\Logs\audio-bridge.log"
nssm set AudioBridge AppStderr "D:\Logs\audio-bridge.err.log"
nssm set AudioBridge AppRotateFiles 1
nssm set AudioBridge AppRotateBytes 10485760
nssm set AudioBridge AppExit Default Restart
nssm set AudioBridge AppRestartDelay 5000
nssm start AudioBridge
```

Same shape for CRM — change `AppDirectory` to `D:\Github\CRM\gravity-mvp` and `server.js` to `npm` with `runtimeArgs` set via `nssm set AudioBridge AppParameters "start"`. NSSM handles graceful shutdown by sending CTRL+C-equivalent — both bridge and CRM SIGTERM/SIGINT handlers fire as documented in §6.

### Task Scheduler (built-in, less flexible)

For lighter setups where NSSM isn't desired. Sample task XML lives in `deploy/windows/audio-bridge-task.xml`. Limitations vs NSSM: no automatic restart-on-crash without scripting, no log rotation. Acceptable for short-lived dev boxes; not recommended for unattended prod.

---

## 5. PM2 (cross-platform, Node-native)

Ecosystem config in `deploy/pm2/ecosystem.config.js`. After install:

```bash
npm install -g pm2
pm2 start deploy/pm2/ecosystem.config.js
pm2 save                              # persist across host reboot
pm2 startup                           # generate init-system hook
```

The config sets:
- `restart_delay: 5000` — same 5 s wait as systemd
- `max_restarts: 5` + `min_uptime: '60s'` — five restart attempts within a minute, then stop trying (matches systemd `StartLimitBurst`)
- `max_memory_restart: '1G'` for CRM, `'512M'` for bridge — catches leaks before OOMKiller does
- `error_file` / `out_file` — separate stdout/stderr log files, rotated by `pm2-logrotate` module (`pm2 install pm2-logrotate`)

PM2 also exposes `pm2 status` / `pm2 logs` for live ops, useful for operators not running a journald-aware host.

---

## 6. Graceful shutdown semantics

### CRM (`gravity-mvp`)

On `SIGTERM` / `SIGINT` (`instrumentation.ts:269-350`), in order, with 10 s force-exit timer:

1. `OperationalJobs.clearAllIntervals()` — stop periodic recovery / integrity / retention jobs
2. Destroy all WhatsApp clients (closes Puppeteer's Chromes so they don't hold userDataDir locks)
3. Stop Telegram health-check + disconnect TG clients
4. Stop BullMQ transcribe / analyze workers + close Redis connection
5. Disconnect Prisma
6. `process.exit(0)`

In-flight HTTP requests under Next.js are NOT explicitly drained — the 10 s `forceExit` covers them. For long-running endpoints (~rare — most are sub-second) consider sending SIGTERM during a low-traffic window.

`uncaughtException` and `unhandledRejection` handlers are present (`instrumentation.ts:355-389`): uncaught crashes log `uncaught_exception` and best-effort destroy WA clients before exiting 1; unhandled rejections are logged but don't terminate.

### AudioBridge (`tools/audio-bridge-day1`)

On `SIGTERM` / `SIGINT` (`server.js:850-851`):

1. Active `CallSession` objects in the in-memory `sessions` Map die with the process
2. FreeSWITCH sees WS drop, eventually hangs up the affected channels
3. CRM's stale-session reaper (PR #43) marks orphaned Call rows as `failed` after 30 min
4. New AI-calls fail at originate until the bridge respawns

**Active AI-calls do NOT survive a bridge restart.** This is documented, intentional, and not currently a persistence-layer problem worth solving — see the production-hardening assessment.

### FreeSWITCH

FS has its own shutdown semantics (`fs_cli -x 'shutdown'` does a clean teardown). Don't kill -9 unless absolutely necessary — gracefully shutting down clears the gateway registration with Megafon and avoids re-registration storm.

---

## 7. Operational runbooks

Short, copy-pasteable. No enterprise process.

### «Bridge crashed»

```
1. Check supervisor status: systemctl status audio-bridge   (or nssm status / pm2 status)
2. If supervisor already restarted it — check logs for the root cause:
   journalctl -u audio-bridge -n 200 --no-pager           (systemd)
   pm2 logs audio-bridge --lines 200                      (pm2)
   tail -n 200 D:\Logs\audio-bridge.err.log               (NSSM)
3. Verify health: bash scripts/check_health.sh
4. Affected in-flight calls: stale-cleanup reaper at +30 min, or run manually:
   node gravity-mvp/scripts/cleanup_stale_ai_sessions.js
```

### «Redis unavailable»

```
1. Check Redis directly: redis-cli ping     (expect PONG)
2. If Redis truly down — start it. CRM BullMQ workers reconnect automatically.
3. In-flight finalize POSTs from bridge:
   - aiAnalysis enqueue may fail (wrapped in withTimeout 2 s, PR #33)
   - Call row terminal-state still set; aiAnalysis just missing
   - Re-enqueue manually via /api/calls/<id>/re-analyze (or equivalent)
```

### «MinIO unavailable»

```
1. curl -fsS http://127.0.0.1:9000/minio/health/live
2. Restart MinIO. Existing connections retry transparently (PR #54).
3. In-flight uploads: if MinIO was down for the full ~17 s retry window,
   the WAV stays on disk in /var/lib/freeswitch/recordings/. Grep for
   `recording_upload_failed{staleRecordingOnDiskExpected:true}` in logs;
   re-process via the call's CRM detail page (button to be added) or
   manual ESL replay.
```

### «CRM unavailable»

```
1. Check /api/health/infra:
   curl -fsS http://127.0.0.1:3002/api/health/infra
2. If 503 — body breakdown shows which dep is down. Run the corresponding runbook.
3. If unreachable — restart CRM via supervisor.
4. Bridge → CRM calls bounded at 5 s (PR #55) and finalize retries 3 × 5 s (PR #52).
   In-flight bridge dialogs will fail-soft per-call: dialog continues locally,
   transcript items / state updates drop, finalize eventually exhausts retry
   budget → stale-cleanup at +30 min.
5. After CRM is back, any AI-call rows stuck in `active`/`greeting` will be
   reconciled by stale-cleanup on the next sweep.
```

### «Megafon trunk down»

```
1. fs_cli -x "sofia status gateway megafon"     (expect State: REGED)
2. If FAIL_WAIT / TRYING — check Megafon SBC reachability:
   nc -zvu sbc.megafon.ru 5060
3. Verify SIP credentials in telephony/.env haven't expired.
4. Outbound AI-calls fail at originate (visible via opsLog
   `originate_bgapi_result_err`). Inbound calls don't ring.
5. No in-platform recovery — wait for Megafon, then FS re-registers
   automatically every 60 s.
```

### «Yandex STT timeout storm»

```
1. Check bridge logs for the inactivity event:
   grep yandex_stt_inactivity_timeout  bridge.log | jq -r .callUuid | wc -l
2. If many in short window — Yandex SpeechKit is degraded. Yandex status
   page: https://status.yandex.cloud/
3. Failover to Whisper while Yandex is down:
   set AI_CALL_STT_PROVIDER=whisper in the bridge env, restart bridge.
   Per-call: stays on Yandex until bridge restarts (per-process, not per-call).
4. Calls during the storm: silence-timer ends them after ~16 s (acceptable
   degraded UX). No data lost — transcripts up to the stall are persisted
   via appendTranscript.
```

### «AudioBridge stuck in active forever»

```
1. The legitimate ceiling is 30 min (stale-cleanup reaper). Anything later
   indicates the reaper itself is failing.
2. Manual probe:  STALE_AI_SESSION_DRY_RUN=1  node gravity-mvp/scripts/cleanup_stale_ai_sessions.js
   — reports how many rows would be touched.
3. If non-zero AND > 30 min after their startedAt — reaper isn't running.
   Check that the cron / OperationalJob entry that drives it is active:
   grep stale_ai_sessions /var/log/crm.log  (or check pm2 logs)
4. As a one-shot:  node gravity-mvp/scripts/cleanup_stale_ai_sessions.js
```

---

## 8. Boot-sanity check

After bringing the stack up the first time (or after a host reboot), one-liner:

```bash
# Linux / macOS
bash scripts/check_health.sh
echo "exit=$?"

# Windows
pwsh scripts/check_health.ps1
echo "exit=$LASTEXITCODE"
```

Expected fresh-deploy output:
```
ok
exit=0
```

If you get `degraded` (exit 1) — the JSON body lists which dep is failing; head straight to that dep's runbook above. If `unreachable` (exit 3) — CRM process is down; check the supervisor.

For monitor wiring (cron / Uptime Kuma / Task Scheduler) see `docs/operations/health-monitoring.md`.

---

## 9. What this layer does NOT do

Intentionally out of scope, listed here so future operators don't expect them:

- **Bridge active-call persistence**: a bridge restart drops in-flight dialogs. Persistent session state is a separate architectural decision; stale-cleanup is the current mitigation.
- **Kubernetes / Docker Swarm**: single-host supervision is sufficient at current scale.
- **Centralised log aggregation**: opsLog writes JSON-lines to stdout/stderr. Pair with Loki / Promtail / journald / pm2-logrotate externally — recipes per supervisor in §3–§5 above.
- **Metrics endpoint**: `/api/health/infra` is the boolean signal; histogram/counter exposure waits until external aggregator is deployed.
- **HA / failover** between hosts: one host today.
- **CI/CD pipeline**: deployments are manual git pull + supervisor restart.
- **Automated TLS / cert rotation**: HTTPS is a reverse-proxy concern (nginx / Caddy), not in scope here.

Each item is a real future PR when the operational story demands it.

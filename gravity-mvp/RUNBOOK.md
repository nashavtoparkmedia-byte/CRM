# CRM Operational Runbook

## Contact & Channel Lifecycle Contract

### Contact Resolution (deterministic)

Both live inbound messages and history sync use `ContactService.resolveContact()`:

1. Find existing `ContactIdentity(channel, externalId)` → return existing Contact
2. If phone available → find `ContactPhone(phone)` → attach new Identity to existing Contact
3. If no match → create new Contact + Phone + Identity

**Limitation:** If channel does not provide phone (Telegram via bot, MAX without phone), auto-linking is not possible. A separate Contact is created.

### Channel Disconnect (non-destructive)

| Preserved | Deleted |
|-----------|---------|
| Contact | Channel connection record (or marked inactive) |
| ContactPhone | — |
| ContactIdentity | — |
| Chat (unified) | — |
| Messages | — |
| Driver link | — |
| Merge history | — |

### Channel Disconnect + Delete Data (destructive)

| Preserved | Deleted |
|-----------|---------|
| Contact | Messages of this channel |
| ContactPhone | Chats of this channel |
| Driver link | Dangling ContactIdentity (if no Chat remains) |
| Merge history | Channel connection record |
| Other channel data | — |

**Rule:** Contact remains as an entity even if all channels are removed. It becomes an empty card — not deleted, not archived. Operator can re-link channels or merge manually.

### Invariants (never violated by channel operations)

- Contact is never deleted by channel disconnect/delete
- ContactPhone is never deleted by channel disconnect/delete
- Driver link (yandexDriverId) is never modified by channel operations
- ContactMerge history is never deleted by channel operations
- Other channels' Chat/Message/Identity are never affected

---

## System Health Check

```bash
# Quick health check
curl -s http://localhost:3002/api/health | jq .status

# Full health snapshot
curl -s http://localhost:3002/api/health | jq .

# Transport-only health
curl -s http://localhost:3002/api/transport/health | jq .
```

### Status Values

| Status | Meaning | Action |
|--------|---------|--------|
| `ok` | All systems operational | None |
| `degraded` | Partial issues, system functional | Check `degradedReasons` array |
| `error` | Critical failure | Immediate investigation required |

### Degraded Reasons Reference

| Reason | Meaning | Diagnostic |
|--------|---------|------------|
| `transport_failed` | WA or TG connection failed (max retries exceeded) | Check transport section |
| `transport_reconnecting` | Active reconnect in progress | Usually self-resolves |
| `prolonged_transport_degradation` | Connection degraded >5 min | Check maxDegradedMs, may need manual restart |
| `stuck_messages` | Outbound messages stuck in 'sent' >5 min | Recovery job should handle; check recovery section |
| `recovery_job_crashed` | Periodic recovery job threw error | Check recovery.lastError |
| `integrity_critical` | Critical data integrity issue found | Check integrity.issues array |
| `integrity_warning` | Warning-level data integrity issue | Check integrity.issues array |

---

## Diagnosing WhatsApp Issues

### WA Stale Client / Watchdog Recovery

```bash
# Check WA connection state
curl -s http://localhost:3002/api/health | jq '.transport.whatsapp'

# Check watchdog status
curl -s http://localhost:3002/api/health | jq '.watchdog'
```

**If unhealthyCount > 0:**
1. Watchdog already detected stale client and marked as failed
2. Reconnect policy will attempt recovery (up to 10 attempts, exponential backoff)
3. Check logs for `wa_watchdog_stale` events

**Manual recovery (if auto-recovery fails):**
```bash
# Check server logs for WA errors
# Look for: wa_watchdog_stale, puppeteer_crash, state_failed
grep -i "wa_watchdog\|puppeteer_crash\|state_failed" logs/

# Restart the CRM server (graceful shutdown will clean up)
# The server will re-initialize all ready WA connections on startup
```

### WA Connection Stuck in Failed State

```bash
# Check specific connection
curl -s http://localhost:3002/api/health | jq '.transport.whatsapp.connections[] | select(.state == "failed")'
```

**Recovery:** Restart server. WA warmup re-initializes all `ready`/`authenticated` connections from DB.

---

## Diagnosing Telegram Issues

### TG Prolonged Degradation

```bash
# Check TG transport state
curl -s http://localhost:3002/api/health | jq '.transport.telegram'

# Check degradation duration
curl -s http://localhost:3002/api/health | jq '.transport.maxDegradedMs'
```

**If maxDegradedMs > 300000 (5 min):**
1. Check if SOCKS5 proxy is running: `curl -s socks5h://127.0.0.1:10808 http://example.com`
2. Check TG API availability from server
3. Look for `tg_prolonged_degradation` in logs

**Manual recovery:**
```bash
# Restart proxy if needed
# Then restart CRM server — TG listeners re-initialize on startup
```

---

## Diagnosing Message Delivery

### Stuck Messages

```bash
# Check stuck count
curl -s http://localhost:3002/api/health | jq '.pipeline.stuckCount'

# Check recovery job
curl -s http://localhost:3002/api/health | jq '.recovery'
```

**If stuckCount > 0:** Recovery job runs every 5 min and marks stuck messages (>5 min in 'sent') as failed.

### Failed Delivery / Retry Queue

```bash
# Check retry queue
curl -s http://localhost:3002/api/health | jq '.retry'

# Check pending retryable messages count
curl -s http://localhost:3002/api/health | jq '.retry.pendingRetryable'
```

**Retry behavior:**
- Retryable errors: timeout, transport unavailable, network errors
- Terminal errors: invalid recipient, auth failure — NOT retried
- Max 3 attempts per message, exponential backoff (30s, 60s, 120s, cap 10min)
- Messages older than 24h are not retried
- Retry job runs every 2 min, processes up to 10 messages per run

### Error Code Reference

| Code | Meaning | Retryable |
|------|---------|-----------|
| `TRANSPORT_UNAVAILABLE` | No ready connection for channel | Yes |
| `TIMEOUT` | Send/import timeout | Yes |
| `NETWORK_ERROR` | Connection refused/reset/broken | Yes |
| `TRANSPORT_CRASH` | Puppeteer/protocol crash | Yes |
| `RECIPIENT_NOT_FOUND` | User not found in channel | No |
| `AUTH_FAILURE` | Authentication/authorization failed | No |
| `VALIDATION_ERROR` | Invalid request/target | No |
| `UNKNOWN` | Unclassified error | No (safe default) |

---

## Manual Recovery Actions

### Safe Actions (no data loss)

| Action | Command | Effect |
|--------|---------|--------|
| Restart CRM server | `Ctrl+C` then `npm run dev` | Re-inits transports, re-registers jobs, recovers stuck messages |
| Check DB connectivity | `curl localhost:3002/api/health` | Verifies DB access via health endpoint |
| Force integrity check | Wait for next 30-min cycle or restart | IntegrityChecker runs on startup + every 30 min |

### Dangerous Actions (use with caution)

| Action | Risk | When to use |
|--------|------|-------------|
| Delete WA session data | Requires re-authentication via QR | Only if WA is completely broken |
| Reset message status in DB | May cause duplicate sends | Only for specific stuck messages, never bulk |

---

## Periodic Jobs Reference

| Job | Interval | Purpose | Overlap Guard |
|-----|----------|---------|---------------|
| `recovery` | 5 min | Mark stuck outbound messages (>5 min in 'sent') as failed | Yes |
| `integrity` | 30 min | Read-only data integrity checks | Yes |
| `message_retry` | 2 min | Retry retryable failed messages (max 10/run, max 3 attempts) | Yes |
| `wa_watchdog` | 60 sec | Check WA client health, detect stale puppeteer | Yes |
| TG health check | 60 sec | Check TG client connectivity, trigger reconnect | Via _healthInterval guard |

---

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `TELEGRAM_BOT_URL` | No | `http://localhost:3001` | TG bot webhook base URL |
| `MAX_SCRAPER_URL` | No | `http://localhost:3005` | MAX web scraper base URL |
| `TG_PROXY_HOST` | No | — | SOCKS5 proxy host for Telegram |
| `TG_PROXY_PORT` | No | — | SOCKS5 proxy port |
| `NEXT_PUBLIC_MAX_SCRAPER_URL` | No | `http://localhost:3005` | Frontend MAX scraper URL |
| `APP_VERSION` | No | `unknown` | Shown in health endpoint |
| `RETENTION_DRY_RUN` | No | `false` | If `true`, cleanup counts but doesn't delete |

---

## Data Retention Policy

| Data | Retention | Cleanup |
|------|-----------|---------|
| Driver, Contact (active) | Indefinite | Never |
| Message (delivered/read) | 12 months | Auto-delete oldest first |
| Message (failed, terminal) | 90 days | Auto-delete oldest first |
| Retry metadata | 30 days after failure | Auto-purge (keep error string) |
| DriverEvent, CommunicationEvent | 6 months | Auto-delete |
| ApiLog | 30 days | Auto-delete |
| Archived contacts | 12 months after archive | Auto-delete (with safety checks) |
| ContactMerge (audit) | Indefinite | Never |

### Cleanup Job

```bash
# Check cleanup status
curl -s http://localhost:3002/api/health | jq '.lifecycle'

# Enable dry-run mode (count only, no delete)
# Set RETENTION_DRY_RUN=true in .env, restart server
```

Cleanup runs every 24 hours. Each run is bounded (LIMIT per table), idempotent, timeout-protected (30s).

---

## Safety Procedures

### Safe Cleanup Procedure

```bash
# 1. Check current data state
curl -s http://localhost:3002/api/health | jq '{lifecycle, integrity}'

# 2. Enable dry-run first
echo 'RETENTION_DRY_RUN=true' >> .env
# Restart server, wait for next cleanup cycle, check health

# 3. Verify dry-run results
curl -s http://localhost:3002/api/health | jq '.lifecycle'
# Should show deletedMessagesLastRun > 0 but dryRun: true

# 4. Disable dry-run for real cleanup
# Remove RETENTION_DRY_RUN from .env, restart
```

### Safe Restart Procedure

```bash
# 1. Check health before restart
curl -s http://localhost:3002/api/health | jq .status

# 2. Graceful shutdown (Ctrl+C or SIGTERM)
# Server will: stop intervals → close WA → close TG → disconnect DB
# Timeout: 10 seconds

# 3. Start server
npm run dev  # or npm start

# 4. Verify post-restart
# Wait 10s for init, then:
curl -s http://localhost:3002/api/health | jq .status
# Should return "ok" or "degraded" (reconnecting is normal)
```

### Safe Migration Procedure

```bash
# 1. Stop server gracefully
# 2. Backup database
pg_dump -h localhost -U postgres tg_bot_db > backup_$(date +%Y%m%d).sql

# 3. Apply migration
cd gravity-mvp
npx prisma migrate deploy

# 4. Start server
npm run dev

# 5. Verify
curl -s http://localhost:3002/api/health | jq .status
```

### Safe Rollback Procedure

```bash
# 1. Stop server
# 2. Restore database from backup
psql -h localhost -U postgres tg_bot_db < backup_YYYYMMDD.sql

# 3. Revert code to previous commit
git checkout <previous-commit>

# 4. Start server
npm run dev

# 5. Verify
curl -s http://localhost:3002/api/health | jq .status
```

# CRM Production Configuration Baseline

## Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db?schema=public` |

### Recommended

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_URL` | `http://localhost:3001` | TG bot webhook base URL |
| `MAX_SCRAPER_URL` | `http://localhost:3005` | MAX web scraper base URL |
| `NEXT_PUBLIC_MAX_SCRAPER_URL` | `http://localhost:3005` | Frontend MAX scraper URL |
| `TG_PROXY_HOST` | — | SOCKS5 proxy for Telegram |
| `TG_PROXY_PORT` | — | SOCKS5 proxy port |
| `APP_VERSION` | `unknown` | Version tag for health endpoint |
| `RETENTION_DRY_RUN` | `false` | Set `true` for cleanup dry-run mode |
| `NODE_ENV` | `development` | Set `production` for production |

### Database Pool

Prisma default: 5 connections. For production with multiple concurrent channels:

```
DATABASE_URL="postgresql://...?connection_limit=20"
```

---

## Safety Limits

| Limit | Value | Location |
|-------|-------|----------|
| Message retry max attempts | 3 | MessageService.ts |
| Message retry backoff cap | 10 minutes | MessageService.ts |
| Message retry age window | 24 hours | instrumentation.ts |
| Messages per retry run | 10 | instrumentation.ts |
| Transport reconnect max attempts | 10 | TransportRegistry.ts |
| Transport reconnect max delay | 60 seconds | TransportRegistry.ts |
| WA watchdog cooldown | 60 seconds | WhatsAppService.ts |
| Retention cleanup timeout | 30 seconds | RetentionCleanup.ts |
| Graceful shutdown timeout | 10 seconds | instrumentation.ts |
| TG send timeout | 25 seconds | tg-actions.ts |
| WA destroy timeout | 10 seconds | WhatsAppService.ts |

## Periodic Jobs

| Job | Interval | Purpose | Max per run |
|-----|----------|---------|-------------|
| `recovery` | 5 min | Mark stuck messages as failed | unlimited |
| `integrity` | 30 min | Read-only data integrity checks | 5 samples |
| `message_retry` | 2 min | Retry retryable failed messages | 10 messages |
| `wa_watchdog` | 60 sec | Check WA client health | all ready connections |
| `retention_cleanup` | 24 hours | Delete old data per retention policy | bounded per table |
| TG health check | 60 sec | Check TG client connectivity | all cached clients |

All jobs have overlap guard — concurrent execution prevented.

## Retention Policy

| Data | Retention | Batch limit |
|------|-----------|-------------|
| Message (failed) | 90 days | 200/run |
| Message (delivered/read) | 12 months | 200/run |
| Retry metadata | 30 days | 200/run |
| DriverEvent | 6 months | 100/run |
| CommunicationEvent | 6 months | 100/run |
| ApiLog | 30 days | 100/run |
| Archived contacts | 12 months | 50/run |
| ContactMerge | Indefinite | — |
| Driver, Contact (active) | Indefinite | — |

## Deduplication Windows

| Channel | Window | Notes |
|---------|--------|-------|
| WhatsApp inbound | ±5 seconds | Content + time matching |
| Telegram inbound | ±30 seconds | Content + time matching |
| MAX inbound | externalId-based | Unique constraint |

## Health Status Rules

| Status | Conditions |
|--------|------------|
| `ok` | No degraded/error conditions |
| `degraded` | transport_failed, transport_reconnecting, prolonged_transport_degradation (>5min), stuck_messages, integrity_warning/critical |
| `error` | database_access_failure, recovery_job_crashed |

## Startup Sequence

```
1. [0s]    Server process starts
2. [0s]    Shutdown handlers registered (SIGTERM, SIGINT)
3. [0s]    Env var warnings logged
4. [5s]    Telegram listeners initialized
5. [5s]    WhatsApp clients warmed up (fire-and-forget)
6. [5s]    Stuck message recovery (initial run)
7. [5s]    Periodic jobs registered (recovery, integrity, retry, watchdog, cleanup)
8. [35s]   Integrity check (initial run)
9. [∞]     System ready — health endpoint returns ok
```

## Startup Checklist

```bash
# 1. Verify database
curl -s localhost:3002/api/health | jq '.pipeline.totalMessages'
# Should return a number > 0

# 2. Verify transport
curl -s localhost:3002/api/health | jq '.transport'
# Should show connection arrays

# 3. Verify jobs scheduled
curl -s localhost:3002/api/health | jq '{recovery: .recovery.lastRunAt, watchdog: .watchdog.lastRunAt}'
# Both should be non-null after 5+ minutes

# 4. Verify overall health
curl -s localhost:3002/api/health | jq '.status'
# Should return "ok"

# 5. Verify memory baseline
curl -s localhost:3002/api/health | jq '.runtime.memoryMB'
# RSS should be < 500MB in production
```

## 24-Hour Observation Checklist

Monitor these metrics every 4 hours:

```bash
# Quick check script
curl -s localhost:3002/api/health | jq '{
  status,
  uptime: .uptimeSeconds,
  memory: .runtime.memoryMB.rss,
  healthMs: .runtime.healthLatencyMs,
  stuck: .pipeline.stuckCount,
  retryPending: .retry.pendingRetryable,
  watchdogUnhealthy: .watchdog.unhealthyCount,
  degraded: .transport.degradedConnections,
  integrityIssues: (.integrity.issues | length),
  cleanupStatus: .lifecycle.lastCleanupStatus
}'
```

Expected baseline ranges:

| Metric | Expected | Alert if |
|--------|----------|----------|
| status | ok | error |
| memory RSS | < 500MB (prod) | > 1GB |
| health latency | < 100ms | > 1000ms |
| stuck messages | 0 | > 10 |
| retry pending | 0-5 | > 50 |
| watchdog unhealthy | 0 | > 0 for >5min |
| degraded connections | 0 | > 0 for >10min |
| integrity issues | 0-2 (info) | any critical |

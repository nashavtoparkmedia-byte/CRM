/**
 * Next.js Instrumentation Hook
 *
 * Initializes transports, periodic background jobs, and graceful shutdown.
 */
export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return

    // ── PR8.D: HTTPS_PROXY init ─────────────────────────────────────────
    // Node.js fetch (undici) НЕ читает HTTPS_PROXY env по дефолту. Из РФ
    // OpenAI возвращает 403 unsupported_country_region. Initializer ставит
    // setGlobalDispatcher(ProxyAgent(HTTPS_PROXY)) для всех outbound fetch.
    // Это ДОЛЖНО быть первым — до любого dynamic import'а, который может
    // сделать сетевой запрос на старте.
    try {
        const { initProxy } = await import('@/lib/ai-call/init-proxy')
        initProxy()
    } catch (err: any) {
        console.error('[instrumentation] initProxy failed:', err?.message)
    }

    const { operationalLogV1: opsLog } = await import('@/infrastructure/operations/operational-log')
    opsLog('info', 'server_starting', { operation: 'instrumentation' })

    // Warn about missing optional env vars (safe defaults exist)
    const envWarnings: string[] = []
    if (!process.env.TELEGRAM_BOT_URL) envWarnings.push('TELEGRAM_BOT_URL (default: http://localhost:3001)')
    if (!process.env.MAX_SCRAPER_URL) envWarnings.push('MAX_SCRAPER_URL (default: http://localhost:3005)')
    if (!process.env.DATABASE_URL) envWarnings.push('DATABASE_URL (REQUIRED)')
    if (envWarnings.length > 0) {
        opsLog('warn', 'env_vars_missing', { missing: envWarnings })
    }

    // Channel contexts own their provider SDKs. Complete registration before
    // scheduling any recovery or retry job that can invoke MessageService.
    try {
        const [whatsapp, telegram, max] = await Promise.all([
            import('@/modules/whatsapp-channel/public/v1/messaging-delivery-capability'),
            import('@/modules/telegram-channel/public/v1/messaging-delivery-capability'),
            import('@/modules/max-channel/public/v1/messaging-delivery-capability'),
        ])
        whatsapp.registerWhatsAppMessagingDeliveryCapabilityV1()
        telegram.registerTelegramMessagingDeliveryCapabilityV1()
        max.registerMaxMessagingDeliveryCapabilityV1()
        opsLog('info', 'channel_delivery_capabilities_registered', { operation: 'instrumentation' })
    } catch (err: any) {
        opsLog('error', 'channel_delivery_capabilities_registration_failed', {
            operation: 'instrumentation',
            error: err.message,
        })
    }

    // Delay initialization to let DB connection pool warm up
    setTimeout(async () => {
        // ── Configuration validation ────────────────────────────────────
        try {
            const { validateAllConfigs, validateCronSchedules } = await import('@/lib/config-validator')
            const configResult = validateAllConfigs()
            if (!configResult.valid) {
                opsLog('error', 'config_validation_failed', {
                    operation: 'startup',
                    count: configResult.errors.length,
                    error: configResult.errors.slice(0, 5).join('; '),
                })
            } else {
                opsLog('info', 'config_validation_passed', { operation: 'startup', count: configResult.checkedRules })
            }
            const cronResult = validateCronSchedules()
            if (!cronResult.valid) {
                opsLog('error', 'cron_schedule_validation_failed', {
                    operation: 'startup',
                    error: cronResult.errors.join('; '),
                })
            }
        } catch (err: any) {
            opsLog('warn', 'config_validation_skipped', { operation: 'startup', error: err.message })
        }

        // ── Database connectivity check ──────────────────────────────────
        try {
            const { prisma } = await import('@/lib/prisma')
            await prisma.$queryRaw`SELECT 1`
            opsLog('info', 'database_connected', { operation: 'startup' })
        } catch (err: any) {
            opsLog('error', 'database_connection_failed', { operation: 'startup', error: err.message })
            // Don't abort — some operations may still work
        }

        // ── Telegram init ────────────────────────────────────────────────
        try {
            const { initializeOperationalTelegramRuntimeV1 } = await import('@/infrastructure/telegram/operational-capabilities')
            await initializeOperationalTelegramRuntimeV1()
            opsLog('info', 'telegram_init_success', { operation: 'startup' })
        } catch (err: any) {
            opsLog('error', 'telegram_init_failed', { operation: 'startup', error: err.message })
        }

        // ── WhatsApp zombie cleanup (runs BEFORE warmup) ─────────────────
        // Reclaims state from zombie puppeteer chromes + stale lock files
        // left behind by an unclean previous exit (taskkill, crash, sleep).
        // Without this, warmup fails with "browser is already running for userDataDir".
        try {
            const { cleanupStaleWhatsAppRuntimeV1 } = await import('@/modules/whatsapp-channel/public/v1/runtime-operations')
            const result = await cleanupStaleWhatsAppRuntimeV1()
            opsLog('info', 'whatsapp_cleanup_done', {
                operation: 'startup',
                killedChromeCount: result.killedChromeCount,
                removedLockCount: result.removedLockCount,
            })
        } catch (err: any) {
            // Don't block startup — log and continue to warmup.
            opsLog('error', 'whatsapp_cleanup_error', { operation: 'startup', error: err.message })
        }

        // ── WhatsApp warmup ──────────────────────────────────────────────
        try {
            const { prisma } = await import('@/lib/prisma')
            const { initializeWhatsAppRuntimeV1 } = await import('@/modules/whatsapp-channel/public/v1/runtime-operations')
            // Include 'error'/'idle' so connections that crashed or expired in a
            // previous container run are retried on startup. If the session file
            // is still valid on disk → auto-reconnect; if not → QR shown in UI.
            const readyConns = await prisma.whatsAppConnection.findMany({
                where: { status: { in: ['ready', 'authenticated', 'error', 'idle'] } },
                select: { id: true, name: true, status: true },
            })
            opsLog('info', 'whatsapp_warmup_start', { operation: 'startup', count: readyConns.length })
            // FIX 8: sequential warmup — previous parallel forEach caused Chromium process storms
            // and races on LocalAuth folder when multiple connections existed.
            for (const conn of readyConns) {
                try {
                    await initializeWhatsAppRuntimeV1(conn.id)
                    opsLog('info', 'whatsapp_warmup_success', { connectionId: conn.id })
                } catch (err: any) {
                    opsLog('error', 'whatsapp_warmup_failed', { connectionId: conn.id, error: err.message })
                }
            }
        } catch (err: any) {
            opsLog('error', 'whatsapp_warmup_error', { operation: 'startup', error: err.message })
        }

        // ── Initial stuck message recovery ───────────────────────────────
        try {
            const { MessageService } = await import('@/lib/MessageService')
            const recovered = await MessageService.recoverStuckMessages(5)
            if (recovered > 0) {
                opsLog('info', 'stuck_recovery_startup', { count: recovered })
            }
        } catch (err: any) {
            opsLog('error', 'stuck_recovery_startup_failed', { error: err.message })
        }

        // ── Periodic jobs ────────────────────────────────────────────────
        const { OperationalJobs } = await import('@/lib/OperationalJobs')

        // Stuck recovery: every 5 minutes
        const recoveryInterval = setInterval(async () => {
            const { MessageService } = await import('@/lib/MessageService')
            await OperationalJobs.run('recovery', async () => {
                const count = await MessageService.recoverStuckMessages(5)
                return { count, at: new Date().toISOString() }
            })
        }, 5 * 60 * 1000)
        OperationalJobs.registerInterval(recoveryInterval)

        // Integrity checks: every 30 minutes
        const integrityInterval = setInterval(async () => {
            const { IntegrityChecker } = await import('@/lib/IntegrityChecker')
            await OperationalJobs.run('integrity', async () => {
                return await IntegrityChecker.runAll()
            })
        }, 30 * 60 * 1000)
        OperationalJobs.registerInterval(integrityInterval)

        // Run integrity check once at startup (after 30s delay)
        setTimeout(async () => {
            const { IntegrityChecker } = await import('@/lib/IntegrityChecker')
            await OperationalJobs.run('integrity', async () => {
                return await IntegrityChecker.runAll()
            })
        }, 30000)

        // Message retry: every 2 minutes
        const retryInterval = setInterval(async () => {
            await OperationalJobs.run('message_retry', async () => {
                const { prisma } = await import('@/lib/prisma')
                const { MessageService } = await import('@/lib/MessageService')

                // Bounded query: retryable, under max retries, under 24h age, ordered by oldest first
                const candidates = await prisma.$queryRaw<Array<{ id: string }>>`
                    SELECT id FROM "Message"
                    WHERE status = 'failed'
                      AND direction = 'outbound'
                      AND (metadata->>'retryable')::text = 'true'
                      AND COALESCE((metadata->>'retryAttempt')::int, 0) < COALESCE((metadata->>'maxRetries')::int, 3)
                      AND "sentAt" > NOW() - INTERVAL '24 hours'
                    ORDER BY "sentAt" ASC
                    LIMIT 10
                `

                let retriedCount = 0
                for (const { id } of candidates) {
                    const result = await MessageService.retrySend(id)
                    if (result.error !== 'Backoff not elapsed') {
                        retriedCount++
                    }
                }
                return { retriedCount, candidatesFound: candidates.length, at: new Date().toISOString() }
            })
        }, 2 * 60 * 1000)
        OperationalJobs.registerInterval(retryInterval)

        // WA watchdog: every 60 seconds
        const watchdogInterval = setInterval(async () => {
            await OperationalJobs.run('wa_watchdog', async () => {
                const { checkWhatsAppRuntimeHealthV1 } = await import('@/modules/whatsapp-channel/public/v1/runtime-operations')
                const results = await checkWhatsAppRuntimeHealthV1()
                return results
            })
        }, 60 * 1000)
        OperationalJobs.registerInterval(watchdogInterval)

        // Avito temporary phone expiration: every hour mark expired temp
        // phones inactive. Avito rotates the disposable proxy numbers, so
        // a temp ContactPhone older than its expiresAt is no longer reachable
        // and would only confuse ContactService.resolveByPhone if it stuck
        // around (Avito would reissue the same number to a different lead).
        const tempPhoneExpInterval = setInterval(async () => {
            await OperationalJobs.run('temp_phone_expire', async () => {
                const { prisma } = await import('@/lib/prisma')
                const { deactivateContactPhoneV1 } = await import('@/modules/contacts/public/v1')
                const { DEACTIVATE_CONTACT_PHONE_COMMAND_V1 } = await import('@/contracts/contacts/v1')
                const expired = await prisma.contactPhone.findMany({
                    where: {
                        isTemporary: true,
                        isActive: true,
                        expiresAt: { lt: new Date() },
                    },
                    select: { id: true },
                })
                await Promise.all(expired.map((phone) => deactivateContactPhoneV1({ contract: DEACTIVATE_CONTACT_PHONE_COMMAND_V1, contactPhoneId: phone.id })))
                return { deactivated: expired.length, at: new Date().toISOString() }
            })
        }, 60 * 60 * 1000)  // every hour
        OperationalJobs.registerInterval(tempPhoneExpInterval)

        // Retention cleanup: every 24 hours
        const cleanupInterval = setInterval(async () => {
            await OperationalJobs.run('retention_cleanup', async () => {
                const { RetentionCleanup } = await import('@/lib/RetentionCleanup')
                const dryRun = process.env.RETENTION_DRY_RUN === 'true'
                return await RetentionCleanup.runAll(dryRun)
            })
        }, 24 * 60 * 60 * 1000)
        OperationalJobs.registerInterval(cleanupInterval)

        // Daily stability check: every 24 hours (offset 1 hour after cleanup)
        const stabilityInterval = setInterval(async () => {
            await OperationalJobs.run('stability_check', async () => {
                const { runStabilityCheck } = await import('@/lib/stability-check')
                return await runStabilityCheck('daily')
            })
        }, 24 * 60 * 60 * 1000)
        OperationalJobs.registerInterval(stabilityInterval)

        // Run initial stability check 60s after startup
        setTimeout(async () => {
            await OperationalJobs.run('stability_check', async () => {
                const { runStabilityCheck } = await import('@/lib/stability-check')
                return await runStabilityCheck('daily')
            })
        }, 60000)

        // ── Telephony: ESL listener to FreeSWITCH ─────────────────────────
        try {
            const { registerCompletedCallTimelineProjectorV1 } = await import('@/modules/calling/public/v1')
            const { messagingCompletedCallTimelineProjectorV1 } = await import('@/modules/messaging/public/v1')
            registerCompletedCallTimelineProjectorV1(messagingCompletedCallTimelineProjectorV1)
            const { startCallingEslRuntimeV1 } = await import('@/modules/calling/public/v1/runtime-startup')
            await startCallingEslRuntimeV1()
            opsLog('info', 'esl_listener_started', { operation: 'startup' })
        } catch (err: any) {
            opsLog('error', 'esl_listener_start_failed', { operation: 'startup', error: err.message })
        }

        // ── Call processing pipeline (BullMQ): transcribe + analyze ──────
        // Stage 4. Workers pick up jobs published from RecordingReady.v1 and
        // jobs enqueued by each other (transcribe → analyze). Safe to start
        // before Redis is up; the workers will retry on connect.
        try {
            const { startCallingProcessingRuntimeV1 } = await import('@/modules/calling/public/v1/runtime-startup')
            startCallingProcessingRuntimeV1()
            opsLog('info', 'call_workers_started', { operation: 'startup' })
        } catch (err: any) {
            opsLog('error', 'call_workers_start_failed', { operation: 'startup', error: err.message })
        }

        // ── Transactional outbox publisher ──────────────────────────────
        // The expand migration is deployed before this compatible code.
        // Atomic claims make concurrent Next.js processes safe; consumers use
        // stable idempotency keys and poison events remain visible.
        try {
            const { startDomainOutboxPublisherV1 } = await import('@/modules/platform-shell/public/v1')
            const outboxInterval = startDomainOutboxPublisherV1()
            OperationalJobs.registerInterval(outboxInterval)
            opsLog('info', 'domain_outbox_publisher_started', { operation: 'startup' })
        } catch (err: any) {
            opsLog('error', 'domain_outbox_publisher_start_failed', { operation: 'startup', error: err.message })
        }

        // Yandex Fleet sync: target time 03:00 server time, daily.
        // Strategy: tick every hour; only run if (current hour == 03) AND no
        // successful run today. Cheap, robust to server restarts during the
        // night, and idempotent if Next.js spins up multiple workers (the
        // SyncStatus 'running' lock prevents concurrent runs).
        const YANDEX_SYNC_HOUR = 3
        let lastYandexSyncDay: string | null = null
        const yandexSyncInterval = setInterval(async () => {
            const now = new Date()
            const today = now.toISOString().slice(0, 10)
            if (now.getHours() !== YANDEX_SYNC_HOUR) return
            if (lastYandexSyncDay === today) return  // already ran today

            await OperationalJobs.run('yandex_fleet_sync', async () => {
                const { runScheduledYandexSyncV1 } = await import('@/modules/fleet-operations/public/v1/yandex-sync-runtime')
                const result = await runScheduledYandexSyncV1()
                if (result.ok) {
                    lastYandexSyncDay = today
                }
                return result
            })
        }, 60 * 60 * 1000)  // every hour
        OperationalJobs.registerInterval(yandexSyncInterval)

        opsLog('info', 'periodic_jobs_registered', { jobs: ['recovery:5m', 'integrity:30m', 'message_retry:2m', 'wa_watchdog:60s', 'retention_cleanup:24h', 'stability_check:24h', 'yandex_fleet_sync:24h@03:00'] })

    }, 5000) // 5 second delay after server start

    // ── Graceful shutdown ────────────────────────────────────────────────
    let shutdownInProgress = false
    const SHUTDOWN_TIMEOUT = 10000

    const shutdown = async (signal: string) => {
        if (shutdownInProgress) return
        shutdownInProgress = true

        const { operationalLogV1: log } = await import('@/infrastructure/operations/operational-log')
        log('info', 'shutdown_start', { signal })

        const forceExit = setTimeout(() => {
            log('warn', 'shutdown_timeout', { signal, timeoutMs: SHUTDOWN_TIMEOUT })
            process.exit(1)
        }, SHUTDOWN_TIMEOUT)
        // Allow process to exit before timer fires if all cleanup is done
        forceExit.unref()

        try {
            // 1. Stop intervals / background jobs
            const { OperationalJobs: ops } = await import('@/lib/OperationalJobs')
            ops.clearAllIntervals()
            log('info', 'shutdown_intervals_cleared')

            // 2. Close WA clients
            try {
                const { destroyWhatsAppRuntimeV1 } = await import('@/modules/whatsapp-channel/public/v1/runtime-operations')
                if (typeof destroyWhatsAppRuntimeV1 === 'function') {
                    await destroyWhatsAppRuntimeV1()
                    log('info', 'shutdown_wa_clients_closed')
                }
            } catch (e: any) {
                log('error', 'shutdown_wa_error', { error: e.message })
            }

            // 3. Stop the TG health monitor. The legacy module has no client-wide disconnect capability.
            try {
                const { stopOperationalTelegramRuntimeV1 } = await import('@/infrastructure/telegram/operational-capabilities')
                await stopOperationalTelegramRuntimeV1()
                log('info', 'shutdown_tg_health_stopped')
            } catch (e: any) {
                log('info', 'shutdown_tg_skip', { error: e.message })
            }

            // 3a. Stop BullMQ workers + close Redis
            try {
                const { stopCallingProcessingRuntimeV1 } = await import('@/modules/calling/public/v1/runtime-startup')
                await stopCallingProcessingRuntimeV1()
                log('info', 'shutdown_queues_closed')
            } catch (e: any) {
                log('error', 'shutdown_queues_error', { error: e.message })
            }

            // 4. Disconnect Prisma
            try {
                const { prisma } = await import('@/lib/prisma')
                await prisma.$disconnect()
                log('info', 'shutdown_prisma_disconnected')
            } catch (e: any) {
                log('error', 'shutdown_prisma_error', { error: e.message })
            }

            log('info', 'shutdown_complete', { signal })
        } catch (err: any) {
            log('error', 'shutdown_error', { error: err.message })
        }

        clearTimeout(forceExit)
        process.exit(0)
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))

    // ── Last-resort handlers ────────────────────────────────────────────
    // Without these, an uncaught error in puppeteer / WA listeners crashes
    // Node.js instantly, leaving zombie chrome processes holding userDataDir
    // locks. We attempt best-effort cleanup, then exit.
    //
    // IMPORTANT: handler is synchronous up to the stderr write so the log
    // is guaranteed to flush before process.exit(). Async import is avoided
    // here because it yields and the log may be lost if exit fires first.
    process.on('uncaughtException', (err: Error) => {
        // Synchronous stderr write — always flushes before exit()
        try {
            process.stderr.write(
                JSON.stringify({ level: 'error', event: 'uncaught_exception', ts: new Date().toISOString(), error: err.message, stack: err.stack }) + '\n'
            )
        } catch {
            try { console.error('[UNCAUGHT]', err.message, err.stack) } catch { /* absolute last resort */ }
        }
        // Best-effort async WA cleanup — we fire-and-forget with a 5s cap then exit.
        const cleanup = (async () => {
            try {
                const { destroyWhatsAppRuntimeV1 } = await import('@/modules/whatsapp-channel/public/v1/runtime-operations')
                await Promise.race([
                    destroyWhatsAppRuntimeV1(),
                    new Promise(resolve => setTimeout(resolve, 5000)),
                ])
            } catch { /* ignore */ }
        })()
        cleanup.finally(() => process.exit(1))
        // Hard cap: even if cleanup hangs, exit after 6s
        setTimeout(() => process.exit(1), 6000).unref()
    })

    process.on('unhandledRejection', (reason: unknown) => {
        // Synchronous log — don't exit on unhandled rejection (typically benign).
        const msg = reason instanceof Error ? reason.message : String(reason)
        const stack = reason instanceof Error ? reason.stack : undefined
        try {
            process.stderr.write(
                JSON.stringify({ level: 'error', event: 'unhandled_rejection', ts: new Date().toISOString(), reason: msg, stack }) + '\n'
            )
        } catch {
            try { console.error('[UNHANDLED]', msg) } catch { /* ignore */ }
        }
    })

}

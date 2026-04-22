/**
 * Next.js Instrumentation Hook
 *
 * Initializes transports, periodic background jobs, and graceful shutdown.
 */
export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return

    const { opsLog } = await import('@/lib/opsLog')
    opsLog('info', 'server_starting', { operation: 'instrumentation' })

    // Warn about missing optional env vars (safe defaults exist)
    const envWarnings: string[] = []
    if (!process.env.TELEGRAM_BOT_URL) envWarnings.push('TELEGRAM_BOT_URL (default: http://localhost:3001)')
    if (!process.env.MAX_SCRAPER_URL) envWarnings.push('MAX_SCRAPER_URL (default: http://localhost:3005)')
    if (!process.env.DATABASE_URL) envWarnings.push('DATABASE_URL (REQUIRED)')
    if (envWarnings.length > 0) {
        opsLog('warn', 'env_vars_missing', { missing: envWarnings })
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
            const { initTelegramListeners } = await import('@/app/tg-actions')
            await initTelegramListeners()
            opsLog('info', 'telegram_init_success', { operation: 'startup' })
        } catch (err: any) {
            opsLog('error', 'telegram_init_failed', { operation: 'startup', error: err.message })
        }

        // ── WhatsApp warmup ──────────────────────────────────────────────
        try {
            const { prisma } = await import('@/lib/prisma')
            const { initializeClient } = await import('@/lib/whatsapp/WhatsAppService')
            const readyConns = await prisma.whatsAppConnection.findMany({
                where: { status: { in: ['ready', 'authenticated'] } },
                select: { id: true, name: true },
            })
            opsLog('info', 'whatsapp_warmup_start', { operation: 'startup', count: readyConns.length })
            // FIX 8: sequential warmup — previous parallel forEach caused Chromium process storms
            // and races on LocalAuth folder when multiple connections existed.
            for (const conn of readyConns) {
                try {
                    await initializeClient(conn.id)
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
                const { checkAllClientsHealth } = await import('@/lib/whatsapp/WhatsAppService')
                const results = await checkAllClientsHealth()
                return results
            })
        }, 60 * 1000)
        OperationalJobs.registerInterval(watchdogInterval)

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

        // Device offline check: every 90 seconds
        const deviceOfflineInterval = setInterval(async () => {
            await OperationalJobs.run('device_offline_check', async () => {
                const { TelephonyService } = await import('@/lib/TelephonyService')
                await TelephonyService.markOfflineStaleDevices()
            })
        }, 90 * 1000)
        OperationalJobs.registerInterval(deviceOfflineInterval)

        opsLog('info', 'periodic_jobs_registered', { jobs: ['recovery:5m', 'integrity:30m', 'message_retry:2m', 'wa_watchdog:60s', 'retention_cleanup:24h', 'stability_check:24h', 'device_offline:90s'] })

    }, 5000) // 5 second delay after server start

    // ── Graceful shutdown ────────────────────────────────────────────────
    let shutdownInProgress = false
    const SHUTDOWN_TIMEOUT = 10000

    const shutdown = async (signal: string) => {
        if (shutdownInProgress) return
        shutdownInProgress = true

        const { opsLog: log } = await import('@/lib/opsLog')
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
                const { destroyAllClients } = await import('@/lib/whatsapp/WhatsAppService')
                if (typeof destroyAllClients === 'function') {
                    await destroyAllClients()
                    log('info', 'shutdown_wa_clients_closed')
                }
            } catch (e: any) {
                log('error', 'shutdown_wa_error', { error: e.message })
            }

            // 3. Stop TG health check + disconnect TG clients
            try {
                const tgModule = await import('@/app/tg-actions') as any
                if (typeof tgModule.stopTelegramHealthCheck === 'function') {
                    tgModule.stopTelegramHealthCheck()
                    log('info', 'shutdown_tg_health_stopped')
                }
                if (typeof tgModule.disconnectAllTelegram === 'function') {
                    await tgModule.disconnectAllTelegram()
                    log('info', 'shutdown_tg_clients_closed')
                }
            } catch (e: any) {
                log('info', 'shutdown_tg_skip', { error: e.message })
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
}

import { withCronLogging } from '@/lib/cron-health'

/**
 * GET /api/cron/init-telegram
 *
 * Fallback route to manually initialize Telegram GramJS listeners.
 * Primary initialization happens at server startup via instrumentation.ts.
 * This route is safe to call multiple times (idempotent).
 */
export const GET = withCronLogging('init-telegram', async () => {
    const { initializeOperationalTelegramRuntimeV1 } = await import('@/infrastructure/telegram/operational-capabilities')
    await initializeOperationalTelegramRuntimeV1()
    return { ok: true, message: 'Telegram listeners initialized' }
})

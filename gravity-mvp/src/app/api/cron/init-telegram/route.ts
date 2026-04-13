import { withCronLogging } from '@/lib/cron-health'

/**
 * GET /api/cron/init-telegram
 *
 * Fallback route to manually initialize Telegram GramJS listeners.
 * Primary initialization happens at server startup via instrumentation.ts.
 * This route is safe to call multiple times (idempotent).
 */
export const GET = withCronLogging('init-telegram', async () => {
    const { initTelegramListeners } = await import('@/app/tg-actions')
    await initTelegramListeners()
    return { ok: true, message: 'Telegram listeners initialized' }
})

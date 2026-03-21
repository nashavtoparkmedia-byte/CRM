import { NextResponse } from 'next/server'

/**
 * GET /api/cron/init-telegram
 * 
 * Fallback route to manually initialize Telegram GramJS listeners.
 * Primary initialization happens at server startup via instrumentation.ts.
 * This route is safe to call multiple times (idempotent).
 */
export async function GET() {
    try {
        const { initTelegramListeners } = await import('@/app/tg-actions')
        await initTelegramListeners()
        return NextResponse.json({ success: true, message: 'Telegram listeners initialized' })
    } catch (err: any) {
        console.error('[INIT-TG-ROUTE] Error:', err.message)
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

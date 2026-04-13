import { NextResponse } from 'next/server'
import { evaluateAutoClose } from '@/lib/triggers'

/**
 * Auto-close churn/onboarding tasks when driver trip activity is detected.
 * Call via CRON: GET /api/cron/auto-close-tasks
 *
 * Checks Driver.lastOrderAt vs Task.createdAt.
 * If the driver had a trip after the task was created → task is auto-closed.
 *
 * closedReason:
 *   churn      → 'returned'   (водитель вернулся)
 *   onboarding → 'launched'   (водитель вышел на линию)
 */
export async function GET() {
    try {
        const result = await evaluateAutoClose()

        return NextResponse.json({
            ok: true,
            ...result,
            timestamp: new Date().toISOString(),
        })
    } catch (error: any) {
        console.error('[auto-close-tasks] Error:', error.message)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

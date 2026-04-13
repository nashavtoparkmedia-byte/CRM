import { NextResponse } from 'next/server'
import { evaluateSLAEscalation } from '@/lib/triggers'

/**
 * Escalate tasks that have breached their SLA deadline.
 * Call via CRON: GET /api/cron/sla-escalation
 *
 * Creates a one-time `sla_escalated` event per task.
 * Safe to call repeatedly — already-escalated tasks are skipped.
 */
export async function GET() {
    try {
        const result = await evaluateSLAEscalation()

        return NextResponse.json({
            ok: true,
            ...result,
            timestamp: new Date().toISOString(),
        })
    } catch (error: any) {
        console.error('[sla-escalation] Error:', error.message)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

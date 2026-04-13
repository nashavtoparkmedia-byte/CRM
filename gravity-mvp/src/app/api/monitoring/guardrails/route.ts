import { NextResponse } from 'next/server'
import { validateAllConfigs } from '@/lib/config-validator'
import { validateCronSchedules } from '@/lib/config-validator'
import { getRecentConfigChanges } from '@/lib/config-validator'
import { checkRuntimeGuardrails } from '@/lib/runtime-guardrails'

export const dynamic = 'force-dynamic'

/**
 * GET /api/monitoring/guardrails
 *
 * Returns full guardrail status:
 * - Configuration validation
 * - Cron schedule verification
 * - Runtime guardrail checks
 * - Recent config changes
 *
 * Used for pre/post-deployment verification (Task 2).
 */
export async function GET() {
    try {
        const configValidation = validateAllConfigs()
        const cronValidation = validateCronSchedules()
        const [runtimeGuardrails, recentChanges] = await Promise.all([
            checkRuntimeGuardrails(),
            getRecentConfigChanges(10),
        ])

        const allValid = configValidation.valid && cronValidation.valid
        const runtimeOk = runtimeGuardrails.status === 'ok'

        let safetyState: 'safe' | 'warning' | 'unsafe'
        if (!allValid || runtimeGuardrails.status === 'critical') {
            safetyState = 'unsafe'
        } else if (!runtimeOk) {
            safetyState = 'warning'
        } else {
            safetyState = 'safe'
        }

        return NextResponse.json({
            ok: true,
            safetyState,
            configValidation,
            cronValidation,
            runtimeGuardrails,
            recentChanges,
            timestamp: new Date().toISOString(),
        })
    } catch (error: any) {
        console.error('[monitoring/guardrails] Error:', error.message)
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }
}

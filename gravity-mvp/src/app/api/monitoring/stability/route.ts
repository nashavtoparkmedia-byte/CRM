import { NextResponse } from 'next/server'
import { runStabilityCheck, getRecentStabilityReports, type CheckScope } from '@/lib/stability-check'

export const dynamic = 'force-dynamic'

const VALID_SCOPES: CheckScope[] = ['daily', 'weekly', 'monthly']

/**
 * GET /api/monitoring/stability?scope=daily|weekly|monthly
 *
 * Returns a full stability report for the requested scope.
 * Default scope: daily.
 *
 * GET /api/monitoring/stability?history=true
 *
 * Returns recent stability check history.
 */
export async function GET(req: Request) {
    try {
        const { searchParams } = new URL(req.url)

        // History mode
        if (searchParams.get('history') === 'true') {
            const limit = Math.min(parseInt(searchParams.get('limit') || '10'), 50)
            const reports = await getRecentStabilityReports(limit)
            return NextResponse.json({ ok: true, reports, timestamp: new Date().toISOString() })
        }

        // Check mode
        const scopeParam = searchParams.get('scope') || 'daily'
        const scope = VALID_SCOPES.includes(scopeParam as CheckScope)
            ? (scopeParam as CheckScope)
            : 'daily'

        const report = await runStabilityCheck(scope)
        return NextResponse.json({ ok: true, report, timestamp: new Date().toISOString() })
    } catch (error: any) {
        console.error('[monitoring/stability] Error:', error.message)
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }
}

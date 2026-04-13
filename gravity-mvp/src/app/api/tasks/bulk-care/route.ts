import { NextResponse } from 'next/server'
import { createBulkCareTasks } from '@/app/tasks/actions'

/**
 * POST /api/tasks/bulk-care
 * Create care tasks in bulk for selected drivers.
 *
 * Body: { driverIds: string[] }
 * Response: { ok: true, created: N, skipped: M }
 */
export async function POST(request: Request) {
    try {
        const body = await request.json()
        const { driverIds } = body

        if (!Array.isArray(driverIds) || driverIds.length === 0) {
            return NextResponse.json(
                { error: 'driverIds must be a non-empty array' },
                { status: 400 }
            )
        }

        if (driverIds.length > 200) {
            return NextResponse.json(
                { error: 'Maximum 200 drivers per request' },
                { status: 400 }
            )
        }

        const result = await createBulkCareTasks(driverIds)

        return NextResponse.json({
            ok: true,
            ...result,
            timestamp: new Date().toISOString(),
        })
    } catch (error: any) {
        console.error('[bulk-care] Error:', error.message)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

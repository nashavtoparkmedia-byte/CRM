import { NextResponse } from 'next/server'
import { resolveEscalation } from '@/app/tasks/actions'

const VALID_RESOLUTION_TYPES = ['contacted', 'reassigned', 'closed']

/**
 * POST /api/tasks/resolve-escalation
 *
 * Body: { taskId: string, resolutionType: 'contacted' | 'reassigned' | 'closed' }
 * Response: { ok: true }
 */
export async function POST(request: Request) {
    try {
        const body = await request.json()
        const { taskId, resolutionType } = body

        if (!taskId || typeof taskId !== 'string') {
            return NextResponse.json(
                { error: 'taskId is required' },
                { status: 400 }
            )
        }

        if (!resolutionType || !VALID_RESOLUTION_TYPES.includes(resolutionType)) {
            return NextResponse.json(
                { error: `resolutionType must be one of: ${VALID_RESOLUTION_TYPES.join(', ')}` },
                { status: 400 }
            )
        }

        const result = await resolveEscalation(taskId, resolutionType)

        return NextResponse.json(result)
    } catch (error: any) {
        console.error('[resolve-escalation] Error:', error.message)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

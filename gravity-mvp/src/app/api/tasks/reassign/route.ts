import { NextResponse } from 'next/server'
import { reassignTasks } from '@/app/team-overview/actions'

/**
 * POST /api/tasks/reassign
 * Reassign tasks to a different manager.
 *
 * Body: { taskIds: string[], newAssigneeId: string }
 * Response: { ok: true, reassigned: N }
 */
export async function POST(request: Request) {
    try {
        const body = await request.json()
        const { taskIds, newAssigneeId } = body

        if (!Array.isArray(taskIds) || taskIds.length === 0) {
            return NextResponse.json(
                { error: 'taskIds must be a non-empty array' },
                { status: 400 }
            )
        }

        if (!newAssigneeId || typeof newAssigneeId !== 'string') {
            return NextResponse.json(
                { error: 'newAssigneeId is required' },
                { status: 400 }
            )
        }

        const result = await reassignTasks(taskIds, newAssigneeId)

        return NextResponse.json({
            ok: true,
            ...result,
            timestamp: new Date().toISOString(),
        })
    } catch (error: any) {
        console.error('[reassign] Error:', error.message)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

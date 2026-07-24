import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/users/user-service'
import { listProjects } from '@/lib/ai-call/scenarios'
import { opsLog } from '@/lib/opsLog'

export const dynamic = 'force-dynamic'

/**
 * GET /api/settings/ai-call-projects
 *
 * Returns active AI-call projects (top-level grouping for scenarios). Used
 * by the settings UI to render scenarios grouped by project.
 */
export async function GET() {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    try {
        const projects = await listProjects()
        return NextResponse.json({ projects })
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'ai_call_projects_list_failed'
        opsLog('error', 'ai_call_projects_list_failed', { operation: 'ai_call_projects', error: message })
        return NextResponse.json({ error: message }, { status: 500 })
    }
}

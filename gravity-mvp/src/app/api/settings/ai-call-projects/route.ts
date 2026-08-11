import { NextResponse } from 'next/server'
import { getCurrentUserIdentityV1 as getCurrentUser } from '@/modules/identity-access/public/v1/user-directory'
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
    } catch (err: any) {
        opsLog('error', 'ai_call_projects_list_failed', { operation: 'ai_call_projects', error: err.message })
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

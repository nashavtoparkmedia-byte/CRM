import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/users/user-service'
import { listScenarios, createScenario } from '@/lib/ai-call/scenarios'
import { opsLog } from '@/lib/opsLog'

export const dynamic = 'force-dynamic'

/**
 * GET  /api/settings/ai-call-scenarios   → list active scenarios
 * POST /api/settings/ai-call-scenarios   → create a new scenario
 *
 * Admin / Руководитель only for POST. GET is open to any authenticated user
 * so the lead card's "Call with AI" button can render the scenario picker.
 */
export async function GET(req: NextRequest) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    try {
        const { searchParams } = new URL(req.url)
        const projectId = searchParams.get('projectId') ?? undefined
        const scenarios = await listScenarios(projectId ? { projectId } : undefined)
        return NextResponse.json({ scenarios })
    } catch (err: any) {
        opsLog('error', 'ai_call_scenarios_list_failed', { operation: 'ai_call_scenarios', error: err.message })
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

export async function POST(req: NextRequest) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (user.role !== 'Администратор' && user.role !== 'Руководитель') {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    let body: any
    try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

    const name = String(body?.name ?? '').trim()
    const systemPrompt = String(body?.systemPrompt ?? '').trim()
    if (!name) return NextResponse.json({ error: 'name_required' }, { status: 400 })
    if (!systemPrompt) return NextResponse.json({ error: 'system_prompt_required' }, { status: 400 })

    try {
        const scenario = await createScenario({
            name,
            description: body?.description ? String(body.description) : undefined,
            systemPrompt,
            questions: Array.isArray(body?.questions) ? body.questions : [],
            targetDurationSec: body?.targetDurationSec ? Number(body.targetDurationSec) : undefined,
            projectId: body?.projectId ? String(body.projectId) : undefined,
        })
        opsLog('info', 'ai_call_scenario_created', { operation: 'ai_call_scenarios', scenarioId: scenario.id })
        return NextResponse.json({ scenario })
    } catch (err: any) {
        opsLog('error', 'ai_call_scenario_create_failed', { operation: 'ai_call_scenarios', error: err.message })
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

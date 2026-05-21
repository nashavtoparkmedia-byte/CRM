import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/users/user-service'
import { getScenario, updateScenario, deleteScenario } from '@/lib/ai-call/scenarios'
import { opsLog } from '@/lib/opsLog'

export const dynamic = 'force-dynamic'

/**
 * GET    /api/settings/ai-call-scenarios/[id]  → fetch one
 * PATCH  /api/settings/ai-call-scenarios/[id]  → partial update
 * DELETE /api/settings/ai-call-scenarios/[id]  → soft delete (isActive=false)
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    const { id } = await params
    const scenario = await getScenario(id)
    if (!scenario) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json({ scenario })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (user.role !== 'Администратор' && user.role !== 'Руководитель') {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    const { id } = await params
    let body: any
    try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

    try {
        const scenario = await updateScenario(id, {
            ...(body.name !== undefined && { name: String(body.name).trim() }),
            ...(body.description !== undefined && { description: String(body.description) }),
            ...(body.systemPrompt !== undefined && { systemPrompt: String(body.systemPrompt) }),
            ...(body.questions !== undefined && { questions: body.questions }),
            ...(body.targetDurationSec !== undefined && { targetDurationSec: Number(body.targetDurationSec) }),
            ...(body.isActive !== undefined && { isActive: Boolean(body.isActive) }),
        })
        opsLog('info', 'ai_call_scenario_updated', { operation: 'ai_call_scenarios', scenarioId: id })
        return NextResponse.json({ scenario })
    } catch (err: any) {
        opsLog('error', 'ai_call_scenario_update_failed', { operation: 'ai_call_scenarios', error: err.message })
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    if (user.role !== 'Администратор' && user.role !== 'Руководитель') {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    const { id } = await params
    try {
        await deleteScenario(id)
        opsLog('info', 'ai_call_scenario_deleted', { operation: 'ai_call_scenarios', scenarioId: id })
        return NextResponse.json({ ok: true })
    } catch (err: any) {
        opsLog('error', 'ai_call_scenario_delete_failed', { operation: 'ai_call_scenarios', error: err.message })
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client types
   for AI-call models may not be regenerated on every dev box. */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getScenario } from '@/lib/ai-call/scenarios'
import { isBridgeMachineRequestAuthenticated } from '@/modules/calling/internal/ai-calls/bridge-machine-auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/ai-calls/sessions/by-fs-uuid/[fsUuid]
 *
 * Audio bridge ↔ CRM resolver. The bridge calls this on CHANNEL_PARK with
 * the FreeSWITCH call UUID and gets back the Call row + the scenario the
 * dialog should follow.
 *
 * Returns 404 if no Call row matches the UUID (the bridge treats 404 as
 * "ad-hoc test call, no dialog") so 404 here is NOT a server error.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ fsUuid: string }> }) {
    if (!isBridgeMachineRequestAuthenticated(req.headers)) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    const { fsUuid } = await ctx.params
    if (!fsUuid) return NextResponse.json({ error: 'fsUuid_required' }, { status: 400 })

    const call = await (prisma as any).call.findUnique({
        where: { fsUuid },
        select: {
            id: true,
            isAi: true,
            aiScenarioId: true,
            driverId: true,
            contactId: true,
            managerId: true,
        },
    })
    if (!call || !call.isAi) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    let scenario = null
    if (call.aiScenarioId) {
        scenario = await getScenario(call.aiScenarioId)
    }
    if (!scenario) return NextResponse.json({ error: 'no_scenario_for_call' }, { status: 404 })

    return NextResponse.json({
        callId: call.id,
        driverId: call.driverId,
        contactId: call.contactId,
        managerId: call.managerId,
        scenario: {
            id: scenario.id,
            name: scenario.name,
            systemPrompt: scenario.systemPrompt,
            questions: scenario.questions,
            targetDurationSec: scenario.targetDurationSec,
        },
    })
}

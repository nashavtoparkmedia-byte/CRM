/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client types
   for AI-call models may not be regenerated on every dev box. */
import { NextRequest, NextResponse } from 'next/server'
import { getScenario } from '@/lib/ai-call/scenarios'
import {
    AiCallFrozenScenarioError,
    resolveBridgeCallScenarioV1,
    type BridgeScenarioV1,
} from '@/modules/calling/internal/ai-calls/ai-call-bridge-scenario-loader'
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
 *
 * A Call that belongs to a campaign attempt executes the scenario the campaign
 * FROZE, not the current row: the snapshot is verified against the Call and its
 * fingerprint, and a corrupt snapshot is a 409 rather than a silent fallback to
 * edited live data. Every other Call resolves exactly as before.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ fsUuid: string }> }) {
    if (!isBridgeMachineRequestAuthenticated(req.headers)) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }

    const { fsUuid } = await ctx.params
    if (!fsUuid) return NextResponse.json({ error: 'fsUuid_required' }, { status: 400 })

    let resolution
    try {
        resolution = await resolveBridgeCallScenarioV1(fsUuid)
    } catch (error) {
        if (error instanceof AiCallFrozenScenarioError) {
            return NextResponse.json({ error: error.code }, { status: 409 })
        }
        throw error
    }
    const call = resolution?.call
    if (!call || !call.isAi) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    // The frozen snapshot wins when the Call belongs to a campaign; every other Call
    // keeps resolving through the live scenario row.
    let scenario: BridgeScenarioV1 | null = resolution?.frozenScenario ?? null
    if (!scenario && call.aiScenarioId) {
        const live = await getScenario(call.aiScenarioId)
        scenario = live === null ? null : {
            id: live.id,
            name: live.name,
            systemPrompt: live.systemPrompt,
            questions: live.questions,
            targetDurationSec: live.targetDurationSec ?? null,
        }
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

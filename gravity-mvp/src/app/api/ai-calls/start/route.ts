/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client types
   for AI-call models may not be regenerated on every dev box. */
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { getCurrentUser } from '@/lib/users/user-service'
import { opsLog } from '@/lib/opsLog'
import { originateAiCall } from '@/lib/ai-call/esl-originate'
import { getScenario, DEFAULT_PROJECT_ID, listScenarios } from '@/lib/ai-call/scenarios'

export const dynamic = 'force-dynamic'

/**
 * POST /api/ai-calls/start
 *
 * Initiate a LIVE AI-call. Different from /api/ai-calls/mock — this one
 * actually originates a SIP channel through FreeSWITCH and lets the
 * audio bridge drive a real STT/LLM/TTS dialog.
 *
 *  body: { driverId?, contactId?, phoneNumber?, scenarioId? }
 *
 * Flow:
 *   1. Resolve the phone number from driverId/contactId/phoneNumber.
 *   2. Resolve a scenario (explicit or "Квалификация лида" default).
 *   3. Pre-allocate fsUuid (UUID) and create a Call row with
 *      isAi=true, aiSessionStatus='starting', fsUuid=<our uuid>.
 *   4. Tell FreeSWITCH to originate: a) {origination_uuid=<our uuid>} so
 *      the bridge can resolve the row later; b) dial-string to the lead's
 *      number; c) park extension 9999 so CHANNEL_PARK fires and the bridge
 *      grabs control.
 *   5. Return { callId, fsUuid } so the UI can navigate to /calls/<id>.
 *
 * If no LLM/STT/TTS provider is available the call still goes through but
 * the bridge stays in audio-only mode — recording happens, dialog does
 * not. Useful for confirming the SIP path before adding API keys.
 */
export async function POST(req: NextRequest) {
    if (process.env.AI_CALL_LIVE_MODE !== 'true') {
        return NextResponse.json(
            {
                error: 'live_mode_disabled',
                hint: 'set AI_CALL_LIVE_MODE=true (separate from AI_CALL_MOCK_MODE) and restart',
            },
            { status: 403 },
        )
    }

    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    let body: any
    try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

    const driverId: string | null = body.driverId ?? null
    const contactId: string | null = body.contactId ?? null
    const phoneNumber: string | null = body.phoneNumber ?? null
    const scenarioId: string | null = body.scenarioId ?? null

    if (!driverId && !contactId && !phoneNumber) {
        return NextResponse.json({ error: 'driverId_or_contactId_or_phoneNumber_required' }, { status: 400 })
    }

    // Resolve toNumber — same logic as the mock endpoint, so the UI calling
    // either works identically.
    let toNumber = phoneNumber ?? ''
    if (!toNumber && driverId) {
        const d = await prisma.driver.findUnique({ where: { id: driverId }, select: { phone: true } })
        toNumber = d?.phone ?? ''
    }
    if (!toNumber && contactId) {
        const c = await prisma.contact.findUnique({
            where: { id: contactId },
            select: { phones: { where: { isPrimary: true }, select: { phone: true }, take: 1 } },
        })
        toNumber = c?.phones[0]?.phone ?? ''
    }
    if (!toNumber) {
        return NextResponse.json({ error: 'no_phone_number_for_lead' }, { status: 400 })
    }

    // Resolve scenario. Explicit ID wins; otherwise grab the first active
    // scenario from the default "Квалификация лида" project.
    let scenario = scenarioId ? await getScenario(scenarioId) : null
    if (!scenario) {
        const list = await listScenarios({ projectId: DEFAULT_PROJECT_ID })
        scenario = list[0] ?? null
    }
    if (!scenario) {
        return NextResponse.json({ error: 'no_active_scenario' }, { status: 400 })
    }

    const fsUuid = randomUUID()
    const fromNumber = process.env.MEGAFON_NUMBER ?? '+79221853150'

    // Create the Call row first so the bridge can resolve it the moment
    // FreeSWITCH parks the channel.
    const call = await prisma.call.create({
        data: {
            direction: 'outbound',
            status: 'initiated',
            fromNumber,
            toNumber,
            driverId,
            contactId,
            managerId: user.id,
            fsUuid,
            startedAt: new Date(),
            isAi: true,
            aiScenarioId: scenario.id,
            aiSessionStatus: 'starting',
            metadata: {
                mock: false,
                liveStartedAt: new Date().toISOString(),
            } as any,
        } as any,
    })

    // Dial string — for MVP we assume a SIP gateway named "megafon" in the
    // FreeSWITCH config. Override via env if your topology differs.
    const dialString = process.env.AI_CALL_DIAL_STRING_TEMPLATE
        ? process.env.AI_CALL_DIAL_STRING_TEMPLATE.replace('${number}', toNumber.replace(/\D/g, ''))
        : `sofia/gateway/megafon/${toNumber.replace(/\D/g, '')}`

    try {
        const fsResponse = await originateAiCall({
            fsUuid,
            dialString,
            extension: process.env.AI_CALL_PARK_EXT ?? '9999',
            callerIdName: 'AI Assistant',
        })
        opsLog('info', 'ai_call_originate_ok', { callId: call.id, fsUuid, fsResponse: fsResponse.slice(0, 200) })
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await (prisma as any).call.update({
            where: { id: call.id },
            data: { aiSessionStatus: 'failed', metadata: { ...((call.metadata as any) ?? {}), originateError: msg } },
        })
        opsLog('error', 'ai_call_originate_failed', { callId: call.id, error: msg })
        return NextResponse.json({ error: 'originate_failed', message: msg, callId: call.id }, { status: 500 })
    }

    return NextResponse.json({
        ok: true,
        callId: call.id,
        fsUuid,
        scenarioId: scenario.id,
        scenarioName: scenario.name,
    })
}

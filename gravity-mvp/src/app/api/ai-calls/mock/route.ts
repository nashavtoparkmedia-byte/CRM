import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { getCurrentUser } from '@/lib/users/user-service'
import { opsLog } from '@/lib/opsLog'
import { getMockPayload, pickRandomVariant, type MockVariant } from '@/lib/ai-call/mock-payload'

export const dynamic = 'force-dynamic'

/**
 * POST /api/ai-calls/mock
 *
 * Mock-mode entry for AI-call testing without Yandex STT/TTS. Creates a
 * completed Call(isAi=true) with synthetic transcript / summary /
 * qualificationResult, and optionally a manager Task when the mock
 * variant says should_create=true.
 *
 * Enabled iff AI_CALL_MOCK_MODE=true. In production with a real STT/TTS
 * pipeline this endpoint will be replaced with a real "start AI-call"
 * action.
 *
 * Body: { driverId?, contactId?, phoneNumber?, scenarioId?, variant? }
 *   variant: 'qualified' | 'not_qualified' | 'unclear' | 'random'
 */
export async function POST(req: NextRequest) {
    if (process.env.AI_CALL_MOCK_MODE !== 'true') {
        return NextResponse.json(
            { error: 'mock_mode_disabled', hint: 'set AI_CALL_MOCK_MODE=true' },
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
    const variantInput: string = body.variant ?? 'random'
    const variant: MockVariant =
        variantInput === 'random'
            ? pickRandomVariant()
            : (['qualified', 'not_qualified', 'unclear'].includes(variantInput) ? (variantInput as MockVariant) : 'qualified')

    if (!driverId && !contactId && !phoneNumber) {
        return NextResponse.json({ error: 'driverId_or_contactId_or_phoneNumber_required' }, { status: 400 })
    }

    // Resolve phone number for fromNumber/toNumber. We're the "from" side
    // (the AI bot), the lead is the "to" side.
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
    if (!toNumber) toNumber = '+70000000000'

    // Validate scenarioId if passed
    let resolvedScenarioId: string | null = scenarioId
    if (scenarioId) {
        const sc = await (prisma as any).aiCallScenario.findUnique({
            where: { id: scenarioId },
            select: { id: true },
        })
        if (!sc) resolvedScenarioId = null
    }

    const mock = getMockPayload(variant)
    const startedAt = new Date(Date.now() - mock.durationSec * 1000)
    const answeredAt = new Date(startedAt.getTime() + 2000)
    const endedAt = new Date()

    // Persist as a single Call row — same table as ordinary manager calls.
    const call = await prisma.call.create({
        data: {
            direction: 'outbound',
            status: 'completed',
            fromNumber: process.env.MEGAFON_NUMBER ?? '+79221853150',
            toNumber,
            driverId,
            contactId,
            managerId: user.id,
            fsUuid: `mock-${randomUUID()}`,
            startedAt,
            answeredAt,
            endedAt,
            durationSec: mock.durationSec,
            hangupCause: 'NORMAL_CLEARING',
            transcript: mock.transcript,
            aiSummary: mock.aiSummary,
            aiAnalysis: mock.qualificationResult as any,
            // AI-call specific fields (Prisma generated client; cast to any
            // in case the local node_modules generator is one regen behind)
            isAi: true,
            aiScenarioId: resolvedScenarioId,
            aiSessionStatus: mock.aiSessionStatus as any,
            metadata: {
                mock: true,
                variant,
                estimatedCostRub: mock.estimatedCostRub,
            } as any,
        } as any,
    })

    // Create a Task for the manager when the mock variant flagged it.
    let createdTask: { id: string; title: string } | null = null
    if (mock.qualificationResult.manager_task.should_create) {
        const task = await prisma.task.create({
            data: {
                driverId,
                contactId,
                source: 'auto',
                type: 'ai_call_followup',
                title: `AI-звонок: ${mock.qualificationResult.lead_summary}`,
                description: mock.qualificationResult.manager_task.summary,
                priority: (mock.qualificationResult.manager_task.priority === 'high'
                    ? 'high'
                    : mock.qualificationResult.manager_task.priority === 'normal'
                    ? 'medium'
                    : 'low') as any,
                status: 'todo',
                createdBy: user.id,
                metadata: {
                    aiCallId: call.id,
                    qualification: mock.qualificationResult.qualification_status,
                } as any,
            },
        })
        createdTask = { id: task.id, title: task.title }

        // Link task back into call.aiAnalysis for easy lookup in the UI.
        await prisma.call.update({
            where: { id: call.id },
            data: {
                aiAnalysis: {
                    ...mock.qualificationResult,
                    created_task_id: task.id,
                } as any,
            },
        })
    }

    opsLog('info', 'ai_call_mock_created', {
        operation: 'ai_call_mock',
        callId: call.id,
        variant,
        qualified: mock.qualificationResult.qualification_status,
        taskId: createdTask?.id,
    })

    return NextResponse.json({
        ok: true,
        callId: call.id,
        variant,
        qualificationStatus: mock.qualificationResult.qualification_status,
        createdTask,
    })
}

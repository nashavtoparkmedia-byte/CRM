/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client types
   for AI-call models may not be regenerated on every dev box. */
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { getCurrentUserIdentityV1 as getCurrentUser } from '@/modules/identity-access/public/v1/user-directory'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { getMockPayload, pickRandomVariant, type MockVariant } from '@/lib/ai-call/mock-payload'
import { isMockModeEnabled } from '@/lib/ai-call/provider-settings'
import { CREATE_TASK_COMMAND_V1 } from '@/contracts/work-management/v1'
import { createTaskV1 } from '@/modules/work-management/public/v1'
import {
    resolveAiCallContactRecipient,
    resolveAiCallDriverRecipient,
} from '@/modules/calling/application/ai-call-recipient'
import {
    createAiCallLifecycleJournal,
    metadataWithAiCallLifecycleJournal,
} from '@/modules/calling/application/ai-call-lifecycle'
import {
    createAiCallTranscriptJournal,
    metadataWithAiCallTranscriptJournal,
    reconcileAiCallTranscriptJournal,
    renderLegacyAiCallTranscriptProjection,
} from '@/modules/calling/application/ai-call-transcript'

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
    // Mock-mode toggle now lives in DB (AiProviderSetting where provider=system,
    // key=mockMode), with .env AI_CALL_MOCK_MODE as a dev fallback.
    if (!(await isMockModeEnabled())) {
        return NextResponse.json(
            {
                error: 'mock_mode_disabled',
                hint: 'turn on Mock-режим on the API keys settings page',
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
    const variantInput: string = body.variant ?? 'random'
    const variant: MockVariant =
        variantInput === 'random'
            ? pickRandomVariant()
            : (['qualified', 'not_qualified', 'unclear'].includes(variantInput) ? (variantInput as MockVariant) : 'qualified')

    if (!driverId && !contactId && !phoneNumber) {
        return NextResponse.json({ error: 'driverId_or_contactId_or_phoneNumber_required' }, { status: 400 })
    }

    // Contact and Driver values are resolved by their data owners. A raw phone
    // is accepted only when neither owner-backed recipient was supplied.
    let toNumber = ''
    if (contactId !== null) {
        const recipient = await resolveAiCallContactRecipient({ contactId, driverId, phoneNumber })
        if (recipient.status === 'invalid_input') {
            return NextResponse.json({ error: recipient.reason }, { status: 400 })
        }
        if (recipient.status === 'unreachable') {
            return NextResponse.json({ error: 'no_phone_number_for_lead' }, { status: 400 })
        }
        toNumber = recipient.phone
    } else if (driverId !== null) {
        const recipient = await resolveAiCallDriverRecipient({ driverId, contactId, phoneNumber })
        if (recipient.status === 'invalid_input') {
            return NextResponse.json({ error: recipient.reason }, { status: 400 })
        }
        if (recipient.status === 'unreachable') {
            return NextResponse.json({ error: 'no_phone_number_for_lead' }, { status: 400 })
        }
        toNumber = recipient.phone
    } else {
        toNumber = phoneNumber ?? ''
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
    const callId = randomUUID()
    const startedAt = new Date(Date.now() - mock.durationSec * 1000)
    const answeredAt = new Date(startedAt.getTime() + 2000)
    const endedAt = new Date()
    let transcriptJournal = createAiCallTranscriptJournal(callId)
    const transcriptRows = mock.transcript.split('\n').map((line, index) => {
        const role = line.startsWith('[Лид]') ? 'user' as const : 'assistant' as const
        const content = line.replace(/^\[(?:Лид|AI)\]\s*/, '').trim()
        const message = {
            messageId: `calling-mock-transcript:v1:${callId}:${index + 1}`,
            ordinal: index + 1,
            role,
            content,
            final: true as const,
            source: 'calling_mock' as const,
        }
        const reconciled = reconcileAiCallTranscriptJournal(callId, transcriptJournal, message, true)
        transcriptJournal = reconciled.journal
        return { id: reconciled.receipt.rowId, role, content }
    })
    const transcriptProjection = renderLegacyAiCallTranscriptProjection(transcriptJournal, transcriptRows)
    const lifecycleJournal = createAiCallLifecycleJournal(callId, mock.aiSessionStatus, true)
    const metadata = metadataWithAiCallLifecycleJournal(
        metadataWithAiCallTranscriptJournal({
            mock: true,
            variant,
            estimatedCostRub: mock.estimatedCostRub,
        }, transcriptJournal),
        lifecycleJournal,
    )

    // Persist as a single Call row — same table as ordinary manager calls.
    const call = await prisma.call.create({
        data: {
            id: callId,
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
            transcript: transcriptProjection,
            aiSummary: mock.aiSummary,
            aiAnalysis: mock.qualificationResult as any,
            // AI-call specific fields (Prisma generated client; cast to any
            // in case the local node_modules generator is one regen behind)
            isAi: true,
            aiScenarioId: resolvedScenarioId,
            aiSessionStatus: mock.aiSessionStatus as any,
            aiMessages: {
                create: transcriptRows.map((row, index) => ({
                    id: row.id,
                    role: row.role,
                    content: row.content,
                    startedAt: new Date(startedAt.getTime() + index),
                })),
            },
            metadata: metadata as any,
        } as any,
    })

    // Create a Task for the manager when the mock variant flagged it.
    let createdTask: { id: string; title: string } | null = null
    if (mock.qualificationResult.manager_task.should_create) {
        const taskResult = await createTaskV1({
            contract: CREATE_TASK_COMMAND_V1,
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
                    : 'low'),
                status: 'todo',
                createdBy: user.id,
                metadata: {
                    aiCallId: call.id,
                    qualification: mock.qualificationResult.qualification_status,
                },
            },
        })
        const task = taskResult.task
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

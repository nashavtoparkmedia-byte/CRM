/* eslint-disable @typescript-eslint/no-explicit-any -- Same rationale as
   src/lib/ai-call/scenarios.ts: Prisma client types for AI-call models
   may not be regenerated on every dev box. */
import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { getUsers } from '@/lib/users/user-service'
import CallDetailClient, { type CallDetail } from '@/app/calls/[id]/CallDetailClient'

export const dynamic = 'force-dynamic'

/**
 * /calls/[id] — single call detail view.
 *
 * Three tabs (per Stage 4 design): Аудио / Транскрипт / AI-анализ. Initial
 * snapshot is fetched server-side from Prisma; the client component then
 * subscribes to /api/calls/stream and patches its local state when new
 * `updated` events arrive for this callId (typical sequence: hangup →
 * recording uploaded → transcript ready → AI analysis ready).
 */
export default async function CallDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const call = await prisma.call.findUnique({
        where: { id },
        include: {
            driver: { select: { id: true, fullName: true, phone: true } },
            contact: { select: { id: true, displayName: true } },
        },
    })
    if (!call) notFound()

    let managerName: string | null = null
    if (call.managerId) {
        const users = await getUsers()
        const u = users.find(x => x.id === call.managerId)
        if (u) managerName = `${u.firstName} ${u.lastName}`.trim()
    }

    // AI-call specific data: scenario name and linked Task (for the
    // "Перейти к задаче" link in the qualification panel).
    const cAny = call as any
    let aiScenarioName: string | null = null
    if (cAny.isAi && cAny.aiScenarioId) {
        const sc = await (prisma as any).aiCallScenario.findUnique({
            where: { id: cAny.aiScenarioId },
            select: { name: true },
        })
        aiScenarioName = sc?.name ?? null
    }
    let linkedTask: { id: string; title: string } | null = null
    if (cAny.isAi) {
        // Tasks created by the mock endpoint store callId in metadata.aiCallId
        const task = await (prisma as any).task.findFirst({
            where: { metadata: { path: ['aiCallId'], equals: call.id } as any },
            select: { id: true, title: true },
            orderBy: { createdAt: 'desc' },
        })
        if (task) linkedTask = task
    }
    const estimatedCostRub: number | null =
        (call.metadata as any)?.estimatedCostRub ?? null

    // Serialise to plain JSON so it can cross the server→client boundary.
    const initial: CallDetail = {
        id: call.id,
        direction: call.direction,
        status: call.status,
        fromNumber: call.fromNumber,
        toNumber: call.toNumber,
        startedAt: call.startedAt.toISOString(),
        answeredAt: call.answeredAt?.toISOString() ?? null,
        endedAt: call.endedAt?.toISOString() ?? null,
        durationSec: call.durationSec,
        hangupCause: call.hangupCause,
        recordingPath: call.recordingPath,
        transcript: call.transcript,
        aiScore: call.aiScore,
        aiSummary: call.aiSummary,
        aiAnalysis: (call.aiAnalysis as any) ?? null,
        managerId: call.managerId,
        managerName,
        driver: call.driver,
        contact: call.contact,
        isAi: cAny.isAi ?? false,
        aiSessionStatus: cAny.aiSessionStatus ?? null,
        aiTransferReason: cAny.aiTransferReason ?? null,
        aiScenarioName,
        linkedTask,
        estimatedCostRub,
    }

    return <CallDetailClient initial={initial} />
}

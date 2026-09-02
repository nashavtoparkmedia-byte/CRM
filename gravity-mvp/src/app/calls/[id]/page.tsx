import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { listUserIdentitiesV1 as getUsers } from '@/modules/identity-access/public/v1/user-directory'
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
    const call = await prisma.call.findFirst({
        where: { id, isSimulation: false },
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
    }

    return <CallDetailClient initial={initial} />
}

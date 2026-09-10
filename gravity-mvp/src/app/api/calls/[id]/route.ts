import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { listUserIdentitiesV1 as getUsers } from '@/modules/identity-access/public/v1/user-directory'
import { readControlledRealCallDispatchObservation } from '@/modules/calling/application/controlled-real-ai-call'

/**
 * GET /api/calls/[id]
 *
 * Returns the full Call row (incl. transcript / aiScore / aiSummary /
 * aiAnalysis from Stage 4) together with the linked driver/contact and the
 * manager's display name resolved from users.json. The detail page
 * (/calls/[id]) consumes this on initial render and subsequent updates
 * arrive via SSE on /api/calls/stream.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    try {
        // A known simulation id may be inspected by the detail client, while
        // collection/statistics surfaces continue to exclude simulations.
        const call = await prisma.call.findUnique({
            where: { id },
            include: {
                driver: { select: { id: true, fullName: true, phone: true } },
                contact: { select: { id: true, displayName: true } },
            },
        })
        if (!call) return NextResponse.json({ error: 'not_found' }, { status: 404 })

        // CRM users live in src/data/users.json, not in the DB — look up by id.
        let managerName: string | null = null
        if (call.managerId) {
            const users = await getUsers()
            const u = users.find(x => x.id === call.managerId)
            if (u) managerName = `${u.firstName} ${u.lastName}`.trim()
        }

        const dispatch = readControlledRealCallDispatchObservation(call.metadata)
        return NextResponse.json({
            call: {
                ...call,
                managerName,
                controlledDispatchState: dispatch.state,
                controlledDispatchFailureCode: dispatch.failureCode,
            },
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : 'call_lookup_failed'
        return NextResponse.json({ error: message }, { status: 500 })
    }
}

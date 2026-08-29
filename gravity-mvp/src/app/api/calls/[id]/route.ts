import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { listUserIdentitiesV1 as getUsers } from '@/modules/identity-access/public/v1/user-directory'

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

        return NextResponse.json({ call: { ...call, managerName } })
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

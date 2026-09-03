import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { resolveContactLineageV1 } from '@/modules/contacts/public/v1'

/**
 * GET /api/calls?driverId=&contactId=&managerId=&limit=
 *
 * Returns the most recent calls, optionally filtered. Default limit: 50,
 * max 200. Ordered by startedAt DESC. Used by /calls page and by the
 * "calls history" tab inside a driver / contact card.
 */
export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url)
        const driverId = searchParams.get('driverId')
        const contactId = searchParams.get('contactId')
        const managerId = searchParams.get('managerId')
        const limit = Math.min(Number(searchParams.get('limit') ?? 50), 200)

        const where: Record<string, unknown> = { isSimulation: false }
        if (driverId) where.driverId = driverId
        if (contactId) {
            const lineage = await resolveContactLineageV1(contactId)
            if (!lineage) return NextResponse.json({ calls: [] })
            where.contactId = { in: lineage.contactIds }
        }
        if (managerId) where.managerId = managerId

        const calls = await prisma.call.findMany({
            where,
            orderBy: { startedAt: 'desc' },
            take: limit,
            include: {
                driver: { select: { id: true, fullName: true, phone: true } },
                contact: { select: { id: true, displayName: true } },
            },
        })

        return NextResponse.json({ calls })
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

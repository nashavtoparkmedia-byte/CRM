import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

/**
 * GET /api/calls/[id] — single call with related driver/contact.
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
        return NextResponse.json({ call })
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

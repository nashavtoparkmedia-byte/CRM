import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { EVENTS_LIMIT_DEFAULT } from '@/app/monitoring/lib/constants';

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') || String(EVENTS_LIMIT_DEFAULT))), 50);

    const events = await prisma.driverEvent.findMany({
        where: { driverId: id },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
            id: true,
            eventType: true,
            payload: true,
            createdBy: true,
            createdAt: true,
        },
    });

    return NextResponse.json({
        events: events.map((e) => ({
            ...e,
            createdAt: e.createdAt.toISOString(),
        })),
    });
}

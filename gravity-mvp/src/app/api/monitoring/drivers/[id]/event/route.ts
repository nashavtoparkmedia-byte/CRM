import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { EVENT_TYPE_WHITELIST } from '@/app/monitoring/lib/constants';

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const body = await req.json();

    const { eventType, payload } = body;

    // Validate eventType against whitelist
    if (!eventType || !EVENT_TYPE_WHITELIST.includes(eventType)) {
        return NextResponse.json(
            { error: 'Invalid eventType', allowed: EVENT_TYPE_WHITELIST },
            { status: 400 }
        );
    }

    // Verify driver exists
    const driver = await prisma.driver.findUnique({ where: { id } });
    if (!driver) {
        return NextResponse.json({ error: 'Driver not found' }, { status: 404 });
    }

    const event = await prisma.driverEvent.create({
        data: {
            driverId: id,
            eventType,
            payload: payload || undefined,
            createdBy: body.createdBy || null,
        },
        select: {
            id: true,
            eventType: true,
            createdAt: true,
        },
    });

    return NextResponse.json({
        id: event.id,
        eventType: event.eventType,
        createdAt: event.createdAt.toISOString(),
    });
}

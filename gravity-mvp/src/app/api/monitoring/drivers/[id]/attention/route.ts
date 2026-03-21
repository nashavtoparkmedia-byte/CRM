import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const body = await req.json();

    const { reason, riskLevel = 'medium' } = body;

    if (!reason) {
        return NextResponse.json({ error: 'reason is required' }, { status: 400 });
    }

    if (!['low', 'medium', 'high'].includes(riskLevel)) {
        return NextResponse.json({ error: 'Invalid riskLevel' }, { status: 400 });
    }

    // Verify driver exists
    const driver = await prisma.driver.findUnique({ where: { id } });
    if (!driver) {
        return NextResponse.json({ error: 'Driver not found' }, { status: 404 });
    }

    // Create attention + event in transaction
    const result = await prisma.$transaction(async (tx) => {
        const attention = await tx.driverAttention.create({
            data: {
                driverId: id,
                reason,
                riskLevel,
                createdBy: body.createdBy || null,
            },
        });

        // Create linked attention_marked event with attentionId in payload
        await tx.driverEvent.create({
            data: {
                driverId: id,
                eventType: 'attention_marked',
                payload: { attentionId: attention.id },
                createdBy: body.createdBy || null,
            },
        });

        return attention;
    });

    return NextResponse.json({
        id: result.id,
        status: result.status,
        createdAt: result.createdAt.toISOString(),
    });
}

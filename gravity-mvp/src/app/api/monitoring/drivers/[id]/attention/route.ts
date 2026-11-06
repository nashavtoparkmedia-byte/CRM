import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveRequestOperatorV1 } from '@/modules/identity-access/public/v1/mobile-session-operator';

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const body = await req.json();

    // Under a mobile session the author is the signed operator, never the body (BR-4).
    const operator = await resolveRequestOperatorV1();
    if (operator.kind === 'mobile_session_refused') {
        return NextResponse.json({ error: 'mobile_session_required' }, { status: 401 });
    }
    const createdBy = operator.kind === 'mobile_session' ? operator.operatorId : body.createdBy || null;

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
                createdBy,
            },
        });

        // Create linked attention_marked event with attentionId in payload
        await tx.driverEvent.create({
            data: {
                driverId: id,
                eventType: 'attention_marked',
                payload: { attentionId: attention.id },
                createdBy,
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

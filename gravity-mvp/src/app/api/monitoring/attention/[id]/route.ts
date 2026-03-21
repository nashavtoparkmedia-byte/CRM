import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const body = await req.json();

    if (body.status !== 'resolved') {
        return NextResponse.json({ error: 'Only status "resolved" is supported' }, { status: 400 });
    }

    const attention = await prisma.driverAttention.findUnique({ where: { id } });
    if (!attention) {
        return NextResponse.json({ error: 'Attention item not found' }, { status: 404 });
    }
    if (attention.status === 'resolved') {
        return NextResponse.json({ error: 'Already resolved' }, { status: 409 });
    }

    const updated = await prisma.driverAttention.update({
        where: { id },
        data: {
            status: 'resolved',
            resolvedAt: new Date(),
            resolvedBy: body.resolvedBy || null,
        },
    });

    return NextResponse.json({
        id: updated.id,
        status: updated.status,
        resolvedAt: updated.resolvedAt?.toISOString(),
    });
}

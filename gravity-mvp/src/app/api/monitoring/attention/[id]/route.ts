import { NextRequest, NextResponse } from 'next/server';
import { RESOLVE_DRIVER_ATTENTION_V1, UPDATE_DRIVER_STATE_COMMAND_V1 } from '@/contracts/fleet-operations/v1';
import { updateDriverStateV1 } from '@/modules/fleet-operations/public/v1';

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const body = await req.json();

    if (body.status !== 'resolved') {
        return NextResponse.json({ error: 'Only status "resolved" is supported' }, { status: 400 });
    }

    const result = await updateDriverStateV1({ contract: UPDATE_DRIVER_STATE_COMMAND_V1, operation: RESOLVE_DRIVER_ATTENTION_V1, attentionId: id, resolvedBy: body.resolvedBy || null });
    if (result.status === 'not_found') {
        return NextResponse.json({ error: 'Attention item not found' }, { status: 404 });
    }
    if (result.status === 'already_resolved') {
        return NextResponse.json({ error: 'Already resolved' }, { status: 409 });
    }
    return NextResponse.json({
        id: result.attention!.id,
        status: result.attention!.status,
        resolvedAt: result.attention!.resolvedAt ?? undefined,
    });
}

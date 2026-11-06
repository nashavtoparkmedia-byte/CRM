import { NextRequest, NextResponse } from 'next/server';
import { RESOLVE_DRIVER_ATTENTION_V1, UPDATE_DRIVER_STATE_COMMAND_V1 } from '@/contracts/fleet-operations/v1';
import { updateDriverStateV1 } from '@/modules/fleet-operations/public/v1';
import { resolveRequestOperatorV1 } from '@/modules/identity-access/public/v1/mobile-session-operator';

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const body = await req.json();

    // Under a mobile session the resolver is the signed operator, never the body (BR-4).
    const operator = await resolveRequestOperatorV1();
    if (operator.kind === 'mobile_session_refused') {
        return NextResponse.json({ error: 'mobile_session_required' }, { status: 401 });
    }
    const resolvedBy = operator.kind === 'mobile_session' ? operator.operatorId : body.resolvedBy || null;

    if (body.status !== 'resolved') {
        return NextResponse.json({ error: 'Only status "resolved" is supported' }, { status: 400 });
    }

    const result = await updateDriverStateV1({ contract: UPDATE_DRIVER_STATE_COMMAND_V1, operation: RESOLVE_DRIVER_ATTENTION_V1, attentionId: id, resolvedBy });
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

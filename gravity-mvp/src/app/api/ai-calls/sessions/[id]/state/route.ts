// POST /api/ai-calls/sessions/[id]/state
//
// Bridge → CRM. The bridge informs CRM when an AI-call enters one of
// the two CRM-canonical intermediate states it owns: `greeting` and
// `active`. (Plus `transferring` as defence-in-depth — see the policy
// docstring in `lib/ai-call/state-helpers.js`.)
//
// Out of allowlist:
//   - `thinking` / `speaking` / `listening` / `idle` — these oscillate
//     constantly during a turn and would turn `aiSessionStatus` into
//     noise without operator meaning. They go to bridge stdout via
//     opsLog and never touch the DB.
//   - `starting` — owned by `/api/ai-calls/start/route.ts`.
//   - `ended` / `failed` — owned by `.../finalize/route.ts`.
//
// Idempotency:
//   - Same-state POSTs are no-op (bridge reconnect / retry).
//   - Terminal states (`ended` / `failed`) cannot be overwritten —
//     we don't roll finalized calls back into mid-lifecycle.
//
// Public route by convention (mirrors other bridge ↔ CRM endpoints
// in `tools/audio-bridge-day1/crm-client.js`: finalize / transcript-item
// / by-fs-uuid). The bridge does NOT carry a `crm_user_id` cookie;
// gating this route by user-auth would defeat its purpose. Future
// security work would gate by `BRIDGE_SHARED_TOKEN` instead.

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { opsLog } from '@/lib/opsLog'
import { isAllowedState, isIdempotentNoOp } from '@/lib/ai-call/state-helpers'
import type { AiCallSessionStatus } from '@/lib/ai-call/types'

export const dynamic = 'force-dynamic'

type BridgeOwnedSessionState = Extract<
    AiCallSessionStatus,
    'greeting' | 'active' | 'transferring'
>

function isBridgeOwnedSessionState(state: unknown): state is BridgeOwnedSessionState {
    return isAllowedState(state)
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params
    if (!id) {
        return NextResponse.json({ error: 'id_required' }, { status: 400 })
    }

    let body: { state?: unknown }
    try {
        body = await req.json()
    } catch {
        return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
    }

    const target = body?.state
    if (!isBridgeOwnedSessionState(target)) {
        opsLog('warn', 'ai_call_state_rejected', {
            callId: id,
            reason: 'not_in_allowlist',
            target: typeof target === 'string' ? target : typeof target,
        })
        return NextResponse.json({ error: 'invalid_state' }, { status: 400 })
    }

    const call = await prisma.call.findUnique({
        where: { id },
        select: { id: true, aiSessionStatus: true },
    })
    if (!call) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    if (isIdempotentNoOp(call.aiSessionStatus, target)) {
        // Idempotent path — don't write, don't even bump updatedAt.
        // Return a small marker the bridge can log if it cares.
        opsLog('info', 'ai_call_state_noop', {
            callId: id,
            current: call.aiSessionStatus,
            target,
        })
        return NextResponse.json({
            ok: true,
            callId: id,
            state: call.aiSessionStatus,
            skipped: true,
        })
    }

    // The runtime allowlist above narrows the external payload to the exact
    // bridge-owned subset of the generated Prisma enum.
    await prisma.call.update({
        where: { id },
        data: { aiSessionStatus: target },
    })

    opsLog('info', 'ai_call_state_changed', {
        callId: id,
        from: call.aiSessionStatus,
        to: target,
    })

    return NextResponse.json({
        ok: true,
        callId: id,
        state: target,
        skipped: false,
    })
}

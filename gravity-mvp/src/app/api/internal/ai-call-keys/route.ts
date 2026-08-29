import { NextRequest, NextResponse } from 'next/server'
import { getAllPlaintext } from '@/lib/ai-call/provider-settings'
import { isBridgeMachineRequestAuthenticated } from '@/modules/calling/internal/ai-calls/bridge-machine-auth'

export const dynamic = 'force-dynamic'

/**
 * GET /api/internal/ai-call-keys
 *
 * Plaintext bag of AI-call provider keys, intended for ONE consumer: the
 * AudioBridge process running on the same machine. Returns:
 *
 *   {
 *     openaiApiKey: string | null
 *     yandexApiKey: string | null
 *     yandexFolderId: string | null
 *     mockMode: boolean
 *   }
 *
 * Access requires a well-formed `BRIDGE_SHARED_TOKEN` configuration and an
 * exact `X-Bridge-Token` match. Missing or invalid configuration fails closed;
 * denials expose no diagnostic or secret material.
 *
 * The bridge caches the response in-memory for 60 seconds, so this
 * endpoint is hit at most ~once per minute per session.
 */
export async function GET(req: NextRequest) {
    if (!isBridgeMachineRequestAuthenticated(req.headers)) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const data = await getAllPlaintext()
    // Explicit no-cache headers — secrets should never sit in any
    // intermediate cache, even though the endpoint is internal.
    return new NextResponse(JSON.stringify(data), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            Pragma: 'no-cache',
        },
    })
}

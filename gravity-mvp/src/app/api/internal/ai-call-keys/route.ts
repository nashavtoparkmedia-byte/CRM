/* eslint-disable @typescript-eslint/no-explicit-any -- this endpoint is the
   one place plaintext secrets cross a process boundary; pragmatic cast OK */
import { NextRequest, NextResponse } from 'next/server'
import { getAllPlaintext } from '@/lib/ai-call/provider-settings'

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
 * Access control (defence-in-depth, ALL must pass):
 *
 *   1. Block browser-origin requests. Modern browsers always send the
 *      `Sec-Fetch-Site` header on fetch/XHR/<script>/<a> navigation;
 *      bridge (Node fetch) does not. Presence ⇒ reject. This stops the
 *      most likely attack vector — a logged-in CRM user typing the URL
 *      into the address bar.
 *
 *   2. Then EITHER:
 *      - BRIDGE_SHARED_TOKEN env is set AND request has matching
 *        X-Bridge-Token header (strongest channel — recommended for
 *        any non-localhost deployment), OR
 *      - request appears to come from loopback (remote IP 127.0.0.1 / ::1).
 *        Hostnames are NOT trusted — Host header is attacker-controllable.
 *
 *   3. Method: GET only (no body, no CSRF surface).
 *
 * The bridge caches the response in-memory for 60 seconds, so this
 * endpoint is hit at most ~once per minute per session.
 */
export async function GET(req: NextRequest) {
    const denial = denyReason(req)
    if (denial) {
        return NextResponse.json({ error: 'forbidden', reason: denial }, { status: 403 })
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

function denyReason(req: NextRequest): string | null {
    // Layer 1 — block browser-origin requests outright. Any request that
    // came from a <fetch>, XHR, navigation, script, <img>, etc. gets a
    // Sec-Fetch-Site header from the user agent. A Node-side fetch (used
    // by the bridge) does not set it.
    if (req.headers.get('sec-fetch-site') || req.headers.get('sec-fetch-mode')) {
        return 'browser_origin'
    }

    // Layer 2 — auth signal.
    const expectedToken = process.env.BRIDGE_SHARED_TOKEN
    if (expectedToken) {
        const got = req.headers.get('x-bridge-token')
        return got === expectedToken ? null : 'bad_token'
    }

    // Layer 3 — without a configured token, require true loopback. We
    // DELIBERATELY don't trust the Host header (attacker-controllable)
    // or X-Forwarded-For (proxy-injected). Look at the actual TCP peer.
    const remoteIp =
        (req as any).ip ||  // Next.js edge runtime
        // Node runtime — Next exposes the underlying request on a non-
        // public field; we duck-type defensively.
        ((req as any).socket?.remoteAddress as string | undefined) ||
        ''
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
    const extraAllowed = (process.env.BRIDGE_ALLOWED_IPS ?? '')
        .split(',').map(s => s.trim()).filter(Boolean)
    if (loopback.includes(remoteIp) || extraAllowed.includes(remoteIp)) return null
    return 'not_loopback'
}

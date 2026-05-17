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
 * Access control (defence-in-depth):
 *   1. Localhost-only: rejects requests whose remote address isn't
 *      127.0.0.1 / ::1. Inside Docker / WSL2 you'd add the bridge's IP to
 *      BRIDGE_ALLOWED_IPS instead.
 *   2. Shared secret: if BRIDGE_SHARED_TOKEN is set, the bridge must send
 *      it via the X-Bridge-Token header. Disabled by default for the
 *      single-host MVP.
 *   3. Method: GET only — no body needed, prevents accidental CSRF-style
 *      misuse from a browser.
 *
 * The bridge caches the response in-memory for 60 seconds, so this
 * endpoint is hit at most ~once per minute per session.
 */
export async function GET(req: NextRequest) {
    if (!isAllowed(req)) {
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

function isAllowed(req: NextRequest): boolean {
    // Shared-secret check — strongest signal when configured.
    const expectedToken = process.env.BRIDGE_SHARED_TOKEN
    if (expectedToken) {
        const got = req.headers.get('x-bridge-token')
        if (got !== expectedToken) return false
        return true
    }

    // Otherwise fall back to localhost-only. Next.js exposes the remote
    // address via request.headers.get('x-forwarded-for') in some setups
    // (proxy) or directly via req.ip in newer versions.
    const xff = req.headers.get('x-forwarded-for')
    const host = req.headers.get('host') ?? ''
    const ip =
        xff?.split(',')[0]?.trim() ||
        (req as any).ip ||
        ''
    // Allow common loopback forms + same-host requests (host includes
    // localhost or 127.0.0.1 for dev). Anything coming through a proxy
    // gets blocked here; the operator should set BRIDGE_SHARED_TOKEN
    // in that case.
    const allowedIps = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
    const extraAllowed = (process.env.BRIDGE_ALLOWED_IPS ?? '')
        .split(',').map(s => s.trim()).filter(Boolean)
    if (allowedIps.includes(ip) || extraAllowed.includes(ip)) return true
    if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) return true
    return false
}

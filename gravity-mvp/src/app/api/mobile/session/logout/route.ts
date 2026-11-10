import { type NextRequest } from 'next/server'
import { endMobileSessionForRequestV1 } from '@/modules/identity-access/public/v1/mobile-session-auth'
import { isJsonMutationRequest } from '@/modules/identity-access/public/v1/mutation-request-boundary'

/**
 * POST /api/mobile/session/logout — end the presented mobile session (F-1).
 *
 * The Android shell calls this natively during a context reset (operator
 * switch, fence, CONTINUITY_MISMATCH and the like), before it removes its
 * cookies, so a copy of the cookie that survives anywhere is refused by the
 * request boundary afterwards. It is the same logout the CRM's own «Выйти»
 * performs: push revocation, the durable logout barrier, both cookies cleared.
 *
 * The session comes only from the `yoko_mobile_session` cookie. The body is
 * never read, so nothing in it can name a device, an operator or a session.
 * The route never authenticates and never redirects.
 *
 * Responses (no-store, no body on 204):
 * - 204: the session is ended, or there was none to end — absent, forged,
 *   expired, of an older revocation epoch or already logged out. The caller
 *   learns nothing about which.
 * - 503 MOBILE_SESSION_LOGOUT_UNAVAILABLE: the barrier could not be read or
 *   written, so the presented session may still be live. Retryable.
 * - 415 JSON_REQUIRED: the request is not `application/json`. A cross-site
 *   form or other simple request cannot send that type, and the session
 *   cookie is `SameSite=lax`, so a foreign page cannot log a device out.
 *
 * The request boundary (`proxy.ts`) lets the shell reach this exact path
 * without a live session, so an already-dead session gets 204 here rather
 * than the boundary's 401.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function POST(request: NextRequest) {
    if (!isJsonMutationRequest(request)) {
        return Response.json({ error: 'JSON_REQUIRED' }, { status: 415, headers: NO_STORE })
    }

    const outcome = await endMobileSessionForRequestV1()
    if (outcome === 'unavailable') {
        return Response.json(
            { error: 'MOBILE_SESSION_LOGOUT_UNAVAILABLE' },
            { status: 503, headers: { ...NO_STORE, 'Retry-After': '5' } },
        )
    }
    return new Response(null, { status: 204, headers: NO_STORE })
}

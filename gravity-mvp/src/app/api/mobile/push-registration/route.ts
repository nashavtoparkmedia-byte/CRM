import { type NextRequest } from 'next/server'
import {
    parseRegisterMobilePushDeviceBodyV1,
    type MobilePushRegistrationFailureCodeV1,
} from '@/contracts/identity-access/v1'
import { registerMobilePushDeviceFromSessionV1 } from '@/modules/identity-access/public/v1/mobile-push-session'
import { isJsonMutationRequest } from '@/modules/identity-access/public/v1/mutation-request-boundary'

/**
 * POST /api/mobile/push-registration — Mobile Push v1 device registration.
 *
 * The Android shell posts its current provider token and nothing else:
 * `{ "token": "…" }`. Which device, which operator label, which credential and
 * which session the registration belongs to are all derived by identity_access
 * from the verified mobile session cookie — never from the request. The
 * session is verified here, not left to `proxy.ts`, which only gates requests
 * that identify themselves as the shell.
 *
 * Cross-site requests are refused by construction: the session cookie is
 * `SameSite=lax`, so a foreign page's POST carries no session, and the JSON
 * content type cannot be sent cross-origin without a preflight this route
 * never answers. Responses never echo the token.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY_CHARS = 2048

const FAILURE_STATUS: Record<MobilePushRegistrationFailureCodeV1, number> = {
    MOBILE_SESSION_REQUIRED: 401,
    // The device logged this session out. Re-authenticating is the only way back.
    MOBILE_SESSION_REVOKED: 401,
    // The session predates Mobile Push v1: valid for the CRM, no push identity.
    MOBILE_SESSION_REISSUE_REQUIRED: 401,
    PUSH_DEVICE_ID_NOT_STABLE: 422,
    PUSH_TOKEN_BOUND_TO_OTHER_DEVICE: 409,
}

function respond(status: number, body: Record<string, unknown>): Response {
    return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: NextRequest) {
    if (!isJsonMutationRequest(request)) return respond(415, { error: 'JSON_REQUIRED' })

    const raw = await request.text()
    if (raw.length > MAX_BODY_CHARS) return respond(413, { error: 'BODY_TOO_LARGE' })

    let token: string
    try {
        token = parseRegisterMobilePushDeviceBodyV1(JSON.parse(raw)).token
    } catch {
        return respond(400, { error: 'INVALID_BODY' })
    }

    const result = await registerMobilePushDeviceFromSessionV1(token)
    if (result.ok) return respond(200, { ok: true })
    if (result.code === 'PUSH_TOKEN_BOUND_TO_OTHER_DEVICE') {
        console.warn('[mobile-push] registration refused: token bound to another live device')
    }
    return respond(FAILURE_STATUS[result.code], { error: result.code })
}

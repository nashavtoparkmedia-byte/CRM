import { createSign } from 'node:crypto'
import type { FcmTransportConfigV1 } from './mobile-push-config'
import type { MobilePushSendOutcomeV1, MobilePushTransportV1 } from './mobile-push-ports'

/**
 * Mobile Push v1 — the only code that speaks FCM HTTP v1.
 *
 * Direct HTTP with a service-account JWT signed by node:crypto; no
 * firebase-admin. The provider token of a device is used for exactly one
 * request and is never logged, never placed in an error, and never returned.
 *
 * Error mapping is deliberately conservative. A token is reported bad only
 * when the provider says so about the token itself: UNREGISTERED, or an
 * INVALID_ARGUMENT whose field violation names `message.token`. Any other
 * rejection of the request is OUR fault or a transient one, and must never
 * retire a working registration.
 */

export type { MobilePushMessageV1, MobilePushSendOutcomeV1, MobilePushTransportV1 } from './mobile-push-ports'

export interface FcmTransportDependenciesV1 {
    fetch: typeof fetch
    nowMs: () => number
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const JWT_LIFETIME_SECONDS = 3600
/** Refresh well before Google's one-hour expiry; never hold an access token longer than this. */
const ACCESS_TOKEN_MAX_REUSE_MS = 50 * 60_000
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000
const OAUTH_TIMEOUT_MS = 2_000
const SEND_TIMEOUT_MS = 2_500
/** Push is useful for about a working session; the device session itself lasts 12 h. */
const ANDROID_TTL = '43200s'

function base64Url(value: string | Buffer): string {
    return Buffer.from(value).toString('base64url')
}

function signServiceAccountAssertion(config: FcmTransportConfigV1, nowMs: number): string {
    const issuedAt = Math.floor(nowMs / 1000)
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const claims = base64Url(JSON.stringify({
        iss: config.clientEmail,
        scope: FCM_SCOPE,
        aud: config.oauthAudience,
        iat: issuedAt,
        exp: issuedAt + JWT_LIFETIME_SECONDS,
    }))
    const signer = createSign('RSA-SHA256')
    signer.update(`${header}.${claims}`)
    return `${header}.${claims}.${signer.sign(config.privateKey).toString('base64url')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface FcmErrorFacts {
    status: string
    fcmErrorCode: string | null
    tokenFieldViolation: boolean
}

function readFcmError(body: unknown): FcmErrorFacts {
    const error = isRecord(body) && isRecord(body.error) ? body.error : {}
    const details = Array.isArray(error.details) ? error.details.filter(isRecord) : []
    const fcmDetail = details.find((detail) => detail['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')
    const badRequest = details.find((detail) => detail['@type'] === 'type.googleapis.com/google.rpc.BadRequest')
    const violations = badRequest && Array.isArray(badRequest.fieldViolations)
        ? badRequest.fieldViolations.filter(isRecord)
        : []
    return {
        status: typeof error.status === 'string' ? error.status : '',
        fcmErrorCode: fcmDetail && typeof fcmDetail.errorCode === 'string' ? fcmDetail.errorCode : null,
        tokenFieldViolation: violations.some((violation) => violation.field === 'message.token'),
    }
}

/** Map an FCM HTTP v1 response. Exported so the table itself is directly testable. */
export function classifyFcmSendResponseV1(httpStatus: number, body: unknown): MobilePushSendOutcomeV1 {
    if (httpStatus >= 200 && httpStatus < 300) return { kind: 'delivered' }
    const facts = readFcmError(body)
    const code = facts.fcmErrorCode ?? (facts.status || `HTTP_${httpStatus}`)

    if (facts.fcmErrorCode === 'UNREGISTERED') return { kind: 'token_unregistered' }
    if (facts.fcmErrorCode === 'SENDER_ID_MISMATCH') return { kind: 'sender_mismatch' }
    if (httpStatus === 400 && (facts.fcmErrorCode === 'INVALID_ARGUMENT' || facts.status === 'INVALID_ARGUMENT')) {
        // Only a violation on the token field proves the token is bad. A
        // malformed payload is our defect and must not cost a device its push.
        return facts.tokenFieldViolation ? { kind: 'token_invalid' } : { kind: 'terminal', code: 'INVALID_ARGUMENT' }
    }
    if (httpStatus === 429 || facts.fcmErrorCode === 'QUOTA_EXCEEDED') return { kind: 'retryable', code }
    if (httpStatus >= 500) return { kind: 'retryable', code }
    // Authentication or permission trouble while push is enabled is operational
    // (a key being rotated, an IAM change): retry into the visible dead letter.
    if (httpStatus === 401 || httpStatus === 403) return { kind: 'retryable', code: code === `HTTP_${httpStatus}` ? 'AUTH_REJECTED' : code }
    return { kind: 'terminal', code }
}

export function createFcmHttpV1TransportV1(
    config: FcmTransportConfigV1,
    dependencies: FcmTransportDependenciesV1,
): MobilePushTransportV1 {
    let cachedAccessToken: { value: string, expiresAtMs: number } | null = null

    async function accessToken(): Promise<{ ok: true, value: string } | { ok: false, code: string }> {
        const now = dependencies.nowMs()
        if (cachedAccessToken && cachedAccessToken.expiresAtMs > now) return { ok: true, value: cachedAccessToken.value }
        cachedAccessToken = null

        let response: Response
        try {
            response = await dependencies.fetch(config.oauthTokenUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                    assertion: signServiceAccountAssertion(config, now),
                }).toString(),
                signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
            })
        } catch {
            return { ok: false, code: 'OAUTH_UNREACHABLE' }
        }
        const body: unknown = await response.json().catch(() => null)
        if (!response.ok || !isRecord(body) || typeof body.access_token !== 'string' || body.access_token === '') {
            return { ok: false, code: `OAUTH_REJECTED_${response.status}` }
        }
        const lifetimeMs = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in * 1000 : 0
        cachedAccessToken = {
            value: body.access_token,
            expiresAtMs: now + Math.min(ACCESS_TOKEN_MAX_REUSE_MS, Math.max(0, lifetimeMs - ACCESS_TOKEN_EXPIRY_MARGIN_MS)),
        }
        return { ok: true, value: body.access_token }
    }

    return {
        async send(message) {
            const credential = await accessToken()
            if (!credential.ok) return { kind: 'retryable', code: credential.code }

            let response: Response
            try {
                response = await dependencies.fetch(config.sendUrl, {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${credential.value}`,
                        'content-type': 'application/json',
                    },
                    body: JSON.stringify({
                        message: {
                            token: message.token,
                            data: message.data,
                            android: { priority: 'HIGH', ttl: ANDROID_TTL },
                        },
                    }),
                    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
                })
            } catch {
                return { kind: 'retryable', code: 'FCM_UNREACHABLE' }
            }
            const body: unknown = await response.json().catch(() => null)
            const outcome = classifyFcmSendResponseV1(response.status, body)
            // A rejected access token must not be reused on the next attempt.
            if (response.status === 401) cachedAccessToken = null
            return outcome
        },
    }
}

import { createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { mobileSessionSigningKeyV1 } from '../../application/staff-session-operations'

/**
 * Session primitive for the Android shell (v2, docs/design/mobile-personal-signin-v1.md).
 *
 * The same HMAC-SHA256 envelope and constant-time comparisons as before. What
 * changed in v2 is who the session is: the employee whose own Staff Session
 * password verified at `/login/mobile`, never an operator chosen next to a
 * shared password. So:
 *
 *  - `op`: that employee, carried INSIDE the signed token. The CRM carries the
 *    choice in the unsigned, JS-readable `crm_user_id` cookie, which anyone
 *    can write; in the mobile lane it is the verified employee, and signed.
 *  - `uep`: the employee's StaffCredential.sessionEpoch at sign-in. Every
 *    request compares it with the live row (BR-4 resolver), so a password
 *    reset, a revoke or a browser logout ends the phone session too.
 *  - `did`: an opaque device identifier, so a push registration binds to the
 *    session that created it.
 *  - `rev`: a revocation epoch. Raising MOBILE_SESSION_REVOCATION_EPOCH
 *    invalidates every outstanding mobile session on the next request.
 *  - the signing key is derived from STAFF_SESSION_SECRET under the mobile
 *    lane's own label (`mobileSessionSigningKeyV1`), so a token of this lane
 *    never verifies as a staff or integration-admin token and vice versa. The
 *    shared MOBILE_ACCESS_USER / MOBILE_ACCESS_PASS are no longer read.
 *
 * A v1 token (shared credential) fails the version and the key: every v1
 * session ended when v2 was deployed, and the phone signs in again.
 *
 * IMPORTANT: `op` is an id from the employee registry ("u1", "u2", …). It is
 * NOT a Prisma `CrmUser.id`; those are separate namespaces and the
 * repository says so at schema.prisma's `Call.managerId`. Nothing here may be
 * used to look up a CrmUser row.
 */

export const MOBILE_SESSION_COOKIE = 'yoko_mobile_session'

/** A working day plus margin. Short enough that a lost phone stops working. */
export const MOBILE_SESSION_TTL_SECONDS = 12 * 60 * 60

/** The push credential subject prefix of v2 sessions: `staff-v2:<uep>`. */
export const MOBILE_PUSH_CREDENTIAL_SUBJECT_PREFIX_V2 = 'staff-v2:'

const SESSION_AUDIENCE = 'yoko-gravity-mobile-shell'
const SESSION_VERSION = 2
const MAX_CREDENTIAL_LENGTH = 4096
const MAX_OPERATOR_ID_LENGTH = 64
const MAX_DEVICE_ID_LENGTH = 128
const MAX_STAFF_EPOCH = 2 ** 31 - 1
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/
/** 16 random bytes, base64url, no padding. */
const SESSION_INSTANCE_ID = /^[A-Za-z0-9_-]{22}$/

export interface MobileSessionEnvironment {
    STAFF_SESSION_SECRET?: string
    ADMIN_PASS?: string
    BOT_CRM_SECRET?: string
    MOBILE_SESSION_REVOCATION_EPOCH?: string
}

export interface MobileSessionPrincipalV1 {
    /** `staff-v2:<uep>`: the credential generation this session was proven with. Not a person. */
    credentialSubject: string
    /** The verified employee the session acts as (registry id). Never a Prisma CrmUser.id. */
    runtimeOperatorId: string
    /** The employee's StaffCredential.sessionEpoch when this session was issued. */
    staffEpoch: number
    deviceId: string
    expiresAtSeconds: number
    /**
     * The session instance this token was issued as. Never supplied by the
     * client: it lives inside the signed payload. Every v2 session has one.
     */
    sessionInstanceId: string | null
}

interface MobileSessionPayload {
    v: typeof SESSION_VERSION
    aud: typeof SESSION_AUDIENCE
    op: string
    uep: number
    did: string
    rev: string
    iat: number
    exp: number
    /** Server-issued session instance id: 16 random bytes, minted at issue. */
    sid: string
}

/**
 * Whether the mobile lane can sign sessions: the staff lane has a valid
 * STAFF_SESSION_SECRET. Unprovisioned means closed; there is no fallback to
 * any shared credential.
 */
export function isMobileSessionSigningConfigured(
    env: MobileSessionEnvironment = process.env as unknown as MobileSessionEnvironment,
): boolean {
    return mobileSessionSigningKeyV1(env) !== null
}

/** Current revocation epoch. Any change invalidates every issued session. */
export function getMobileSessionRevocationEpoch(
    env: MobileSessionEnvironment = process.env as unknown as MobileSessionEnvironment,
): string {
    const raw = env.MOBILE_SESSION_REVOCATION_EPOCH?.trim() ?? ''
    return raw === '' ? '0' : raw.slice(0, 64)
}

function signPayload(encodedPayload: string, key: Buffer): Buffer {
    return createHmac('sha256', key)
        .update(`${SESSION_AUDIENCE}\0${encodedPayload}`, 'utf8')
        .digest()
}

function isStaffEpoch(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_STAFF_EPOCH
}

export function isSafeRuntimeOperatorId(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_OPERATOR_ID_LENGTH
        && SAFE_TOKEN.test(value)
}

export function isSafeDeviceId(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_DEVICE_ID_LENGTH
        && SAFE_TOKEN.test(value)
}

/**
 * Issue a session for an employee whose own credential was just verified.
 * Only the mobile sign-in calls this, with the verified employee and the
 * epoch of their credential row.
 */
export function issueMobileSession(
    runtimeOperatorId: string,
    deviceId: string,
    staffEpoch: number,
    env: MobileSessionEnvironment = process.env as unknown as MobileSessionEnvironment,
    nowMs = Date.now(),
): string | null {
    const key = mobileSessionSigningKeyV1(env)
    if (!key) return null
    if (!isSafeRuntimeOperatorId(runtimeOperatorId)) return null
    if (!isSafeDeviceId(deviceId)) return null
    if (!isStaffEpoch(staffEpoch)) return null

    const issuedAt = Math.floor(nowMs / 1000)
    const payload: MobileSessionPayload = {
        v: SESSION_VERSION,
        aud: SESSION_AUDIENCE,
        op: runtimeOperatorId,
        uep: staffEpoch,
        did: deviceId,
        rev: getMobileSessionRevocationEpoch(env),
        iat: issuedAt,
        exp: issuedAt + MOBILE_SESSION_TTL_SECONDS,
        sid: randomBytes(16).toString('base64url'),
    }
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    return `${encodedPayload}.${signPayload(encodedPayload, key).toString('base64url')}`
}

/**
 * Verify a session token and return who it says it is, or null.
 *
 * Returning the principal rather than a boolean is what lets the caller derive
 * the legacy `crm_user_id` UI value from signed data instead of trusting
 * whatever the client happened to send.
 */
export function verifyMobileSession(
    token: unknown,
    env: MobileSessionEnvironment = process.env as unknown as MobileSessionEnvironment,
    nowMs = Date.now(),
): MobileSessionPrincipalV1 | null {
    const key = mobileSessionSigningKeyV1(env)
    if (!key || typeof token !== 'string' || token.length > MAX_CREDENTIAL_LENGTH) return null

    const parts = token.split('.')
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null
    const [encodedPayload, encodedSignature] = parts

    let suppliedSignature: Buffer
    let payload: MobileSessionPayload
    try {
        suppliedSignature = Buffer.from(encodedSignature, 'base64url')
        payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
    } catch {
        return null
    }

    const expectedSignature = signPayload(encodedPayload, key)
    if (
        suppliedSignature.length !== expectedSignature.length
        || !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
        return null
    }

    const nowSeconds = Math.floor(nowMs / 1000)
    const valid = payload?.v === SESSION_VERSION
        && payload.aud === SESSION_AUDIENCE
        && payload.rev === getMobileSessionRevocationEpoch(env)
        && isSafeRuntimeOperatorId(payload.op)
        && isStaffEpoch(payload.uep)
        && isSafeDeviceId(payload.did)
        && Number.isInteger(payload.iat)
        && Number.isInteger(payload.exp)
        && payload.iat <= nowSeconds + 60
        && payload.exp > nowSeconds
        && payload.exp - payload.iat === MOBILE_SESSION_TTL_SECONDS
        // Every v2 session carries a well-formed server-issued instance id.
        && typeof payload.sid === 'string' && SESSION_INSTANCE_ID.test(payload.sid)

    if (!valid) return null

    return {
        credentialSubject: `${MOBILE_PUSH_CREDENTIAL_SUBJECT_PREFIX_V2}${payload.uep}`,
        runtimeOperatorId: payload.op,
        staffEpoch: payload.uep,
        deviceId: payload.did,
        expiresAtSeconds: payload.exp,
        sessionInstanceId: payload.sid,
    }
}

/**
 * Accept only in-app messenger destinations. A login screen must never become
 * an open redirector, and the mobile lane has exactly two legitimate landing
 * places: the messenger and the server-side chat gate.
 */
export function normalizeMobileReturnTo(value: unknown): string {
    const fallback = '/messages'
    if (typeof value !== 'string' || value.length > 1024) return fallback
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback

    try {
        const parsed = new URL(value, 'https://gravity.invalid')
        if (parsed.origin !== 'https://gravity.invalid') return fallback
        const allowed = parsed.pathname === '/messages' || parsed.pathname === '/messages/open'
        if (!allowed) return fallback
        // `phone` is dropped deliberately: /messages?phone= creates a Chat row
        // server-side, so it must never be reachable through a login redirect.
        const search = new URLSearchParams(parsed.search)
        search.delete('phone')
        search.delete('driver')
        const query = search.toString()
        return query ? `${parsed.pathname}?${query}` : parsed.pathname
    } catch {
        return fallback
    }
}

// ── Mobile Push v1: non-secret session fingerprints ─────────────────────────

const SESSION_BINDING_LABEL = 'yoko.mobile-push.session-binding.v3'

/**
 * Identity of ONE mobile session, from the random session instance id the
 * server minted when that session was issued.
 *
 * Uniqueness comes from that randomness, not from any fact about the session:
 * two logins for the same device in the same second, second after second, are
 * still different sessions. Session facts alone could not promise this — they
 * are identical at one-second resolution — and the signed token could not be
 * used either, because every other stored field reconstructs its payload, so a
 * digest of it would verify MOBILE_ACCESS_PASS guesses offline.
 *
 * The digest is only a fixed-width name for a value that is already random and
 * non-secret; it adds no secrecy, and keeps the stored binding one shape.
 * Returns null for a session issued before Mobile Push v1: such a session has
 * no instance id, so push registration refuses it until the next login.
 */
export function mobileSessionBindingIdV1(principal: MobileSessionPrincipalV1): string | null {
    if (!principal.sessionInstanceId) return null
    return createHash('sha256')
        .update(`${SESSION_BINDING_LABEL}\0${principal.sessionInstanceId}`, 'utf8')
        .digest('hex')
}

/**
 * The durable logout barrier entry for one session: its binding and the second
 * that session expires. Logout writes exactly this string, a later bind proven
 * by the same session computes exactly the same string, and an entry whose
 * expiry has passed can be dropped — the session it bars can no longer be
 * presented at all. That keeps the stored barrier bounded by the logins of one
 * session lifetime, never by the lifetime of the device.
 */
export function mobileSessionBarrierEntryV1(principal: MobileSessionPrincipalV1): string | null {
    const binding = mobileSessionBindingIdV1(principal)
    return binding === null ? null : `${binding}.${principal.expiresAtSeconds}`
}

/** The second at which a barrier entry stops mattering, or null if it is not one of ours. */
export function mobileSessionBarrierEntryExpiryV1(entry: string): number | null {
    const [binding, expiry] = entry.split('.')
    if (!/^[0-9a-f]{64}$/.test(binding ?? '') || !/^[0-9]{1,15}$/.test(expiry ?? '')) return null
    return Number(expiry)
}

// ── BR-4: the effective operator of a request ───────────────────────────────

/** The unsigned UI identity selector the legacy CRM reads. Never an authority on its own. */
export const LEGACY_UI_IDENTITY_COOKIE_V1 = 'crm_user_id'

/**
 * Who a request acts as, from its cookies alone.
 *
 * - `mobile_session`: a signed mobile session verified; its `op` is the operator,
 *   whatever `crm_user_id` says and whatever the request's User-Agent claims.
 * - `mobile_session_refused`: a session cookie is present but does not verify
 *   (tampered, expired, epoch bumped, credential rotated, cleared). The request
 *   has no operator: falling back to `crm_user_id` would turn a dead mobile
 *   session into a free choice of identity.
 * - `legacy`: no session cookie at all. This is the browser lane, unchanged.
 *
 * Revocation by logout is not visible here (it is server state); callers that
 * act on a `mobile_session` must also consult the logout barrier.
 */
export type EffectiveOperatorResolutionV1 =
    | { kind: 'mobile_session', operatorId: string, principal: MobileSessionPrincipalV1 }
    | { kind: 'mobile_session_refused' }
    | { kind: 'legacy', operatorId: string | null }

export function resolveEffectiveOperatorV1(
    input: { sessionCookie: string | undefined, legacyCookie: string | undefined },
    env: MobileSessionEnvironment = process.env as unknown as MobileSessionEnvironment,
    nowMs = Date.now(),
): EffectiveOperatorResolutionV1 {
    if (input.sessionCookie === undefined) {
        return { kind: 'legacy', operatorId: input.legacyCookie || null }
    }
    const principal = verifyMobileSession(input.sessionCookie, env, nowMs)
    if (!principal) return { kind: 'mobile_session_refused' }
    return { kind: 'mobile_session', operatorId: principal.runtimeOperatorId, principal }
}

/**
 * Rebuild a Cookie request header so that it carries exactly one
 * `crm_user_id`, equal to `operatorId`, or none when `operatorId` is null.
 *
 * Every other pair is kept byte for byte and in order. All `crm_user_id` pairs
 * are removed first, because a browser may send several (one per path or
 * domain) and readers take whichever comes first.
 */
export function withLegacyUiIdentityCookieV1(cookieHeader: string | null, operatorId: string | null): string {
    if (operatorId !== null && !isSafeRuntimeOperatorId(operatorId)) {
        throw new TypeError('operatorId is not a safe runtime operator id')
    }
    const kept = (cookieHeader ?? '')
        .split(';')
        .map((pair) => pair.trim())
        .filter((pair) => pair !== '' && pair.split('=', 1)[0].trim() !== LEGACY_UI_IDENTITY_COOKIE_V1)
    if (operatorId !== null) kept.push(`${LEGACY_UI_IDENTITY_COOKIE_V1}=${operatorId}`)
    return kept.join('; ')
}

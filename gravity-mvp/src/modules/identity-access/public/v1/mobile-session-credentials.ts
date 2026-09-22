import { createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Session primitive for the Android shell.
 *
 * It is a deliberate copy of the shape already proven by
 * `integration-admin-credentials.ts` — same HMAC-SHA256 envelope, same
 * constant-time comparisons, same fail-closed credential resolution — rather
 * than a second, differently-reasoned authentication design. Four things are
 * added because a phone is not a browser tab:
 *
 *  - `op`: the runtime operator the session acts as, carried INSIDE the signed
 *    token. Today the CRM carries that choice in the unsigned, JS-readable
 *    `crm_user_id` cookie, which anyone can write. In the mobile lane the
 *    choice is made once, at login, and is then signed.
 *  - `did`: an opaque device identifier, so a later stage can bind a push
 *    registration to the session that created it.
 *  - `rev`: a revocation epoch. Raising MOBILE_SESSION_REVOCATION_EPOCH
 *    invalidates every outstanding mobile session on the next request, with no
 *    table and no deploy of new code.
 *  - a derived signing key, so a token minted for this lane can never verify
 *    as an integration-admin token and vice versa.
 *
 * IMPORTANT: `op` is an id from `gravity-mvp/src/data/users.json` ("u1", "u2",
 * …). It is NOT a Prisma `CrmUser.id`; those are separate namespaces and the
 * repository says so at schema.prisma's `Call.managerId`. Nothing here may be
 * used to look up a CrmUser row.
 */

export const MOBILE_SESSION_COOKIE = 'yoko_mobile_session'

/** A working day plus margin. Short enough that a lost phone stops working. */
export const MOBILE_SESSION_TTL_SECONDS = 12 * 60 * 60

const SESSION_AUDIENCE = 'yoko-gravity-mobile-shell'
const SESSION_VERSION = 1
const SESSION_KEY_LABEL = 'yoko-mobile-shell-session-key.v1'
const MAX_CREDENTIAL_LENGTH = 4096
const MAX_OPERATOR_ID_LENGTH = 64
const MAX_DEVICE_ID_LENGTH = 128
const SAFE_TOKEN = /^[A-Za-z0-9_-]+$/
/** 16 random bytes, base64url, no padding. */
const SESSION_INSTANCE_ID = /^[A-Za-z0-9_-]{22}$/

export interface MobileAccessCredentialConfig {
    username: string
    password: string
    /** Which provisioned credential answered. Reported, never logged with values. */
    source: 'mobile_access'
}

export interface MobileSessionEnvironment {
    MOBILE_ACCESS_USER?: string
    MOBILE_ACCESS_PASS?: string
    MOBILE_SESSION_REVOCATION_EPOCH?: string
}

export interface MobileSessionPrincipalV1 {
    /** The credential that was proven. Not a person, a provisioned capability. */
    credentialSubject: string
    /** users.json operator id the session acts as. Never a Prisma CrmUser.id. */
    runtimeOperatorId: string
    deviceId: string
    expiresAtSeconds: number
    /**
     * The session instance this token was issued as, or null for a session
     * issued before Mobile Push v1. Never supplied by the client: it lives
     * inside the signed payload.
     */
    sessionInstanceId: string | null
}

interface MobileSessionPayload {
    v: typeof SESSION_VERSION
    aud: typeof SESSION_AUDIENCE
    sub: string
    op: string
    did: string
    rev: string
    iat: number
    exp: number
    /**
     * Server-issued session instance id: 16 random bytes, minted when this
     * session was issued. Two logins a millisecond apart are still distinct
     * sessions, which no timestamp can promise. Absent in sessions issued
     * before Mobile Push v1 — those stay valid for ordinary CRM access and
     * are refused by push registration until the next login.
     */
    sid?: string
}

function rejectsAsPlaceholder(password: string): boolean {
    const normalized = password.trim().toLowerCase()
    return normalized === 'admin123'
        || normalized === 'password'
        || normalized === 'changeme'
        || /(?:placeholder|replace[-_ ]?me|change[-_ ]?me|__generate)/i.test(normalized)
}

function readCredential(username: unknown, password: unknown): { username: string, password: string } | null {
    const user = typeof username === 'string' ? username.trim() : ''
    const pass = typeof password === 'string' ? password : ''
    if (!user || user.length > 128) return null
    if (pass.length < 12 || pass.length > MAX_CREDENTIAL_LENGTH) return null
    if (rejectsAsPlaceholder(pass)) return null
    return { username: user, password: pass }
}

/**
 * Resolve the credential the mobile lane authenticates against.
 *
 * MOBILE_ACCESS_USER and MOBILE_ACCESS_PASS, and nothing else. There is
 * deliberately no fallback to the project administrator credential: a phone
 * must never carry the password that unlocks integration credentials, and a
 * lane that quietly borrows another lane's secret is one rotation away from
 * surprising whoever rotates it.
 *
 * Unprovisioned means closed. A missing, short, or placeholder value returns
 * null, which disables mobile login entirely rather than opening it. That is
 * the intended behaviour even though it means the lane does nothing until an
 * operator provisions it.
 */
export function getMobileAccessCredentialConfig(
    env: MobileSessionEnvironment = process.env as unknown as MobileSessionEnvironment,
): MobileAccessCredentialConfig | null {
    const dedicated = readCredential(env.MOBILE_ACCESS_USER, env.MOBILE_ACCESS_PASS)
    return dedicated === null ? null : { ...dedicated, source: 'mobile_access' }
}

export function isMobileAccessConfigured(
    env: MobileSessionEnvironment = process.env as unknown as MobileSessionEnvironment,
): boolean {
    return getMobileAccessCredentialConfig(env) !== null
}

/** Current revocation epoch. Any change invalidates every issued session. */
export function getMobileSessionRevocationEpoch(
    env: MobileSessionEnvironment = process.env as unknown as MobileSessionEnvironment,
): string {
    const raw = env.MOBILE_SESSION_REVOCATION_EPOCH?.trim() ?? ''
    return raw === '' ? '0' : raw.slice(0, 64)
}

function constantTimeStringEqual(left: string, right: string): boolean {
    const leftDigest = createHash('sha256').update(left, 'utf8').digest()
    const rightDigest = createHash('sha256').update(right, 'utf8').digest()
    return timingSafeEqual(leftDigest, rightDigest)
}

export function verifyMobileAccessCredentials(
    suppliedUsername: unknown,
    suppliedPassword: unknown,
    env: MobileSessionEnvironment = process.env as unknown as MobileSessionEnvironment,
): boolean {
    const config = getMobileAccessCredentialConfig(env)
    if (!config) return false
    if (typeof suppliedUsername !== 'string' || typeof suppliedPassword !== 'string') return false
    if (suppliedUsername.length > MAX_CREDENTIAL_LENGTH || suppliedPassword.length > MAX_CREDENTIAL_LENGTH) {
        return false
    }

    // Both comparisons always run: a wrong username must not be measurably
    // cheaper to reject than a wrong password.
    const usernameMatches = constantTimeStringEqual(suppliedUsername, config.username)
    const passwordMatches = constantTimeStringEqual(suppliedPassword, config.password)
    return usernameMatches && passwordMatches
}

/**
 * Derive this lane's signing key from the proven credential.
 *
 * The label domain-separates the key, so a token minted here cannot verify
 * against `integration-admin-credentials.ts` even if the two lanes were ever
 * given the same secret. Rotating MOBILE_ACCESS_PASS revokes every outstanding
 * mobile session and touches nothing else.
 */
function sessionKey(config: MobileAccessCredentialConfig): Buffer {
    return createHmac('sha256', config.password)
        .update(`${SESSION_KEY_LABEL}\0${config.username}`, 'utf8')
        .digest()
}

function signPayload(encodedPayload: string, config: MobileAccessCredentialConfig): Buffer {
    return createHmac('sha256', sessionKey(config))
        .update(`${SESSION_AUDIENCE}\0${encodedPayload}`, 'utf8')
        .digest()
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

export function issueMobileSession(
    runtimeOperatorId: string,
    deviceId: string,
    env: MobileSessionEnvironment = process.env as unknown as MobileSessionEnvironment,
    nowMs = Date.now(),
): string | null {
    const config = getMobileAccessCredentialConfig(env)
    if (!config) return null
    if (!isSafeRuntimeOperatorId(runtimeOperatorId)) return null
    if (!isSafeDeviceId(deviceId)) return null

    const issuedAt = Math.floor(nowMs / 1000)
    const payload: MobileSessionPayload = {
        v: SESSION_VERSION,
        aud: SESSION_AUDIENCE,
        sub: config.username,
        op: runtimeOperatorId,
        did: deviceId,
        rev: getMobileSessionRevocationEpoch(env),
        iat: issuedAt,
        exp: issuedAt + MOBILE_SESSION_TTL_SECONDS,
        sid: randomBytes(16).toString('base64url'),
    }
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    return `${encodedPayload}.${signPayload(encodedPayload, config).toString('base64url')}`
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
    const config = getMobileAccessCredentialConfig(env)
    if (!config || typeof token !== 'string' || token.length > MAX_CREDENTIAL_LENGTH) return null

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

    const expectedSignature = signPayload(encodedPayload, config)
    if (
        suppliedSignature.length !== expectedSignature.length
        || !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
        return null
    }

    const nowSeconds = Math.floor(nowMs / 1000)
    const valid = payload?.v === SESSION_VERSION
        && payload.aud === SESSION_AUDIENCE
        && payload.sub === config.username
        && payload.rev === getMobileSessionRevocationEpoch(env)
        && isSafeRuntimeOperatorId(payload.op)
        && isSafeDeviceId(payload.did)
        && Number.isInteger(payload.iat)
        && Number.isInteger(payload.exp)
        && payload.iat <= nowSeconds + 60
        && payload.exp > nowSeconds
        && payload.exp - payload.iat === MOBILE_SESSION_TTL_SECONDS
        // A session either carries a well-formed server-issued instance id or
        // none at all. A malformed one is refused rather than ignored.
        && (payload.sid === undefined || (typeof payload.sid === 'string' && SESSION_INSTANCE_ID.test(payload.sid)))

    if (!valid) return null

    return {
        credentialSubject: payload.sub,
        runtimeOperatorId: payload.op,
        deviceId: payload.did,
        expiresAtSeconds: payload.exp,
        sessionInstanceId: payload.sid ?? null,
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

export interface MobilePushCredentialFactsV1 {
    /** The provisioned mobile credential's username. Not a secret. */
    credentialSubject: string
}

/**
 * The credential facts a push registration is bound to, or null when the
 * mobile lane is not provisioned.
 *
 * OPERATIONAL CONTRACT: rotating MOBILE_ACCESS_PASS must also advance
 * MOBILE_SESSION_REVOCATION_EPOCH. Rotation alone stops new logins and
 * invalidates the cookies immediately, but a registration already bound to a
 * session issued under the old password keeps receiving push until that
 * session's expiry (at most the 12 h TTL). Advancing the epoch makes every
 * such registration ineligible at once. Push v1 deliberately stores no
 * password-derived value to detect the rotation itself: such a value would be
 * an offline verifier for password guesses in the database.
 */
export function currentMobilePushCredentialFactsV1(
    env: MobileSessionEnvironment = process.env as unknown as MobileSessionEnvironment,
): MobilePushCredentialFactsV1 | null {
    const config = getMobileAccessCredentialConfig(env)
    if (!config) return null
    return { credentialSubject: config.username }
}

import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

/**
 * Staff Session v1 — pure primitives (docs/design/staff-session-v1.md, v1.3).
 *
 * The same HMAC-SHA256 envelope as the integration-admin and mobile sessions,
 * with one deliberate difference: the signing key is a dedicated secret,
 * STAFF_SESSION_SECRET, that is never a login credential. Nothing here reads a
 * database, a cookie or the registry; the composition lives in application/.
 *
 * The token names the employee (`sub`, a registry id) and the revocation
 * counters it was issued under. It carries no role: the role is read from the
 * registry at every verification (D1).
 */

export const STAFF_SESSION_TTL_SECONDS = 12 * 60 * 60

const SESSION_AUDIENCE = 'yoko-staff-session'
const SESSION_VERSION = 1
const SESSION_KEY_LABEL = 'yoko.identity-access.staff-session-key.v1'
const SESSION_ID_LABEL = 'yoko.identity-access.staff-session-id.v1'
const MAX_TOKEN_LENGTH = 4096
const MIN_SECRET_BYTES = 32
/** 16 random bytes, base64url, no padding. */
const SESSION_INSTANCE_ID = /^[A-Za-z0-9_-]{22}$/
/** Registry ids: the legacy "u1"… and randomUUID() ids both fit. Same shape BR-4 accepts. */
const SAFE_USER_ID = /^[A-Za-z0-9_-]{1,64}$/
const EPOCH = /^[A-Za-z0-9._-]{1,64}$/

export interface StaffSessionEnvironment {
    STAFF_SESSION_SECRET?: string
    STAFF_SESSION_REVOCATION_EPOCH?: string
    YOKO_STAFF_SESSION_ENFORCE?: string
    ADMIN_PASS?: string
    MOBILE_ACCESS_PASS?: string
    BOT_CRM_SECRET?: string
}

function env(): StaffSessionEnvironment {
    return process.env as unknown as StaffSessionEnvironment
}

function rejectsAsPlaceholder(value: string): boolean {
    const normalized = value.trim().toLowerCase()
    return normalized === 'admin123'
        || normalized === 'password'
        || normalized === 'changeme'
        || /(?:placeholder|replace[-_ ]?me|change[-_ ]?me|__generate|example|dummy|secret-here)/i.test(normalized)
}

/**
 * The one "the staff lane's secret is valid" predicate (C-D4b). The guard,
 * issue, verify and bootstrap all ask this, and nothing else.
 *
 * Valid means: present, at least 32 bytes, not a placeholder, and not equal
 * to any login credential or other lane's secret. Anything else is "no lane".
 */
export function staffSessionSecretV1(environment: StaffSessionEnvironment = env()): string | null {
    const secret = environment.STAFF_SESSION_SECRET ?? ''
    if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES || secret.length > MAX_TOKEN_LENGTH) return null
    if (secret.trim() !== secret || rejectsAsPlaceholder(secret)) return null
    for (const other of [environment.ADMIN_PASS, environment.MOBILE_ACCESS_PASS, environment.BOT_CRM_SECRET]) {
        if (typeof other === 'string' && other.length > 0 && other === secret) return null
    }
    return secret
}

export function isStaffSessionSecretValidV1(environment: StaffSessionEnvironment = env()): boolean {
    return staffSessionSecretV1(environment) !== null
}

/** Browser-lane enforcement. Exactly "on" enables it; anything else is off. */
export function isStaffSessionEnforcedV1(environment: StaffSessionEnvironment = env()): boolean {
    return environment.YOKO_STAFF_SESSION_ENFORCE === 'on'
}

/** STAFF_SESSION_REVOCATION_EPOCH; raising it ends every staff session. Malformed → "0" is refused below. */
export function staffSessionRevocationEpochV1(environment: StaffSessionEnvironment = env()): string | null {
    const value = (environment.STAFF_SESSION_REVOCATION_EPOCH ?? '0').trim() || '0'
    return EPOCH.test(value) ? value : null
}

export function isSafeStaffUserIdV1(value: unknown): value is string {
    return typeof value === 'string' && SAFE_USER_ID.test(value)
}

interface StaffSessionPayloadV1 {
    v: typeof SESSION_VERSION
    aud: typeof SESSION_AUDIENCE
    sub: string
    iat: number
    exp: number
    /** Global revocation epoch at issue. */
    epoch: string
    /** The employee's credential sessionEpoch at issue. */
    uepoch: number
    /** Server-minted session instance id: 16 random bytes. */
    sid: string
}

/** What a cryptographically valid token says. Not yet a principal: the store and the registry decide. */
export interface StaffSessionTokenClaimsV1 {
    userId: string
    userEpoch: number
    sessionInstanceId: string
    issuedAtSeconds: number
    expiresAtSeconds: number
}

function signingKey(secret: string): Buffer {
    // Derived, so a value that ever verifies here can never verify in another lane.
    return createHmac('sha256', secret).update(SESSION_KEY_LABEL, 'utf8').digest()
}

function sign(encodedPayload: string, secret: string): Buffer {
    return createHmac('sha256', signingKey(secret))
        .update(`${SESSION_AUDIENCE}\0${encodedPayload}`, 'utf8')
        .digest()
}

export function issueStaffSessionTokenV1(
    input: { userId: string, userEpoch: number },
    environment: StaffSessionEnvironment = env(),
    nowMs = Date.now(),
): string | null {
    const secret = staffSessionSecretV1(environment)
    const epoch = staffSessionRevocationEpochV1(environment)
    if (secret === null || epoch === null) return null
    if (!isSafeStaffUserIdV1(input.userId) || !Number.isSafeInteger(input.userEpoch) || input.userEpoch < 0) return null
    const issuedAt = Math.floor(nowMs / 1000)
    const payload: StaffSessionPayloadV1 = {
        v: SESSION_VERSION,
        aud: SESSION_AUDIENCE,
        sub: input.userId,
        iat: issuedAt,
        exp: issuedAt + STAFF_SESSION_TTL_SECONDS,
        epoch,
        uepoch: input.userEpoch,
        sid: randomBytes(16).toString('base64url'),
    }
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    return `${encoded}.${sign(encoded, secret).toString('base64url')}`
}

/**
 * Verify signature, version, audience, lifetime and the global epoch. Null for
 * every refusal. The per-employee counter, revocation and the registry record
 * are checked by the caller against live state.
 */
export function readStaffSessionTokenV1(
    token: unknown,
    environment: StaffSessionEnvironment = env(),
    nowMs = Date.now(),
): StaffSessionTokenClaimsV1 | null {
    const secret = staffSessionSecretV1(environment)
    const epoch = staffSessionRevocationEpochV1(environment)
    if (secret === null || epoch === null || typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null
    const parts = token.split('.')
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null
    const [encoded, encodedSignature] = parts
    let supplied: Buffer
    let payload: StaffSessionPayloadV1
    try {
        supplied = Buffer.from(encodedSignature, 'base64url')
        payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
    } catch {
        return null
    }
    const expected = sign(encoded, secret)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null
    const now = Math.floor(nowMs / 1000)
    const valid = payload !== null && typeof payload === 'object'
        && payload.v === SESSION_VERSION
        && payload.aud === SESSION_AUDIENCE
        && isSafeStaffUserIdV1(payload.sub)
        && Number.isInteger(payload.iat)
        && Number.isInteger(payload.exp)
        && payload.iat <= now + 60
        && payload.exp > now
        && payload.exp - payload.iat === STAFF_SESSION_TTL_SECONDS
        && payload.epoch === epoch
        && Number.isSafeInteger(payload.uepoch) && payload.uepoch >= 0
        && typeof payload.sid === 'string' && SESSION_INSTANCE_ID.test(payload.sid)
    if (!valid) return null
    return {
        userId: payload.sub,
        userEpoch: payload.uepoch,
        sessionInstanceId: payload.sid,
        issuedAtSeconds: payload.iat,
        expiresAtSeconds: payload.exp,
    }
}

/**
 * The non-secret id consumers see as `sid`: a labelled sha256 of the random
 * instance id. Never the raw instance id, never a digest of the token.
 */
export function staffSessionIdV1(sessionInstanceId: string): string | null {
    if (!SESSION_INSTANCE_ID.test(sessionInstanceId)) return null
    return createHash('sha256').update(`${SESSION_ID_LABEL}\0${sessionInstanceId}`, 'utf8').digest('hex')
}

export function staffSessionCookieOptionsV1(maxAgeSeconds: number) {
    // __Host- requires Secure, Path=/ and no Domain. Lax keeps a top-level
    // navigation signed in; nothing with a side effect accepts a GET.
    return {
        httpOnly: true,
        secure: true,
        sameSite: 'lax' as const,
        path: '/',
        maxAge: maxAgeSeconds,
    }
}

// ── Passwords ────────────────────────────────────────────────────────────

export const STAFF_PASSWORD_MIN_LENGTH = 10
export const STAFF_PASSWORD_MAX_LENGTH = 256

export const STAFF_SCRYPT_PARAMS_V1 = Object.freeze({
    algo: 'scrypt' as const,
    n: 32768,
    r: 8,
    p: 1,
    maxmemBytes: 64 * 1024 * 1024,
    keyLength: 64,
    saltLength: 16,
})

const COMMON_PASSWORDS = new Set([
    '1234567890', '0123456789', '12345678910', 'qwertyuiop', 'password1', 'password12', 'password123',
    'passw0rd123', 'iloveyou12', 'qwerty1234', 'qwerty12345', '1q2w3e4r5t', '1qaz2wsx3edc', 'zaq12wsxcde',
    'abcdefghij', 'aaaaaaaaaa', '1111111111', 'administrator', 'admin12345', 'welcome123', 'letmein123',
    'йцукенгшщз', 'пароль1234', 'parol12345', 'yokocrm123', 'yoko123456',
])

export type StaffPasswordRefusalV1 = 'password_too_short' | 'password_too_long' | 'password_too_common'

/** Password rules (§4.3). Returns null when acceptable. */
export function staffPasswordRefusalV1(password: unknown): StaffPasswordRefusalV1 | null {
    if (typeof password !== 'string' || password.length < STAFF_PASSWORD_MIN_LENGTH) return 'password_too_short'
    if (password.length > STAFF_PASSWORD_MAX_LENGTH) return 'password_too_long'
    const normalized = password.trim().toLowerCase()
    if (rejectsAsPlaceholder(password) || COMMON_PASSWORDS.has(normalized) || new Set(normalized).size < 4) {
        return 'password_too_common'
    }
    return null
}

export interface StaffPasswordVerifierV1 {
    algo: 'scrypt'
    n: number
    r: number
    p: number
    maxmemBytes: number
    salt: Buffer
    hash: Buffer
}

function scryptAsync(password: string, salt: Buffer, params: { n: number, r: number, p: number, maxmemBytes: number, keyLength: number }): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        scryptCallback(password, salt, params.keyLength, { N: params.n, r: params.r, p: params.p, maxmem: params.maxmemBytes }, (error, key) => {
            if (error) reject(error)
            else resolve(key)
        })
    })
}

export async function createStaffPasswordVerifierV1(password: string): Promise<StaffPasswordVerifierV1> {
    const params = STAFF_SCRYPT_PARAMS_V1
    const salt = randomBytes(params.saltLength)
    const hash = await scryptAsync(password, salt, params)
    return { algo: 'scrypt', n: params.n, r: params.r, p: params.p, maxmemBytes: params.maxmemBytes, salt, hash }
}

let dummyVerifier: Promise<StaffPasswordVerifierV1> | null = null

/** A verifier for no one, so an unknown, disabled or credential-less employee costs the same scrypt. */
function dummyStaffPasswordVerifierV1(): Promise<StaffPasswordVerifierV1> {
    dummyVerifier ??= createStaffPasswordVerifierV1(randomBytes(24).toString('base64url'))
    return dummyVerifier
}

/**
 * Constant-work password check. `verifier` null runs the same scrypt against
 * a dummy verifier and answers false. Parameters are taken from the stored
 * row but bounded to the v1 values, so a tampered row cannot demand more memory.
 */
export async function verifyStaffPasswordV1(password: unknown, verifier: StaffPasswordVerifierV1 | null): Promise<boolean> {
    const candidate = typeof password === 'string' && password.length <= STAFF_PASSWORD_MAX_LENGTH ? password : ''
    const usable = verifier !== null
        && verifier.algo === 'scrypt'
        && verifier.n === STAFF_SCRYPT_PARAMS_V1.n
        && verifier.r === STAFF_SCRYPT_PARAMS_V1.r
        && verifier.p === STAFF_SCRYPT_PARAMS_V1.p
        && verifier.maxmemBytes === STAFF_SCRYPT_PARAMS_V1.maxmemBytes
        && verifier.salt.length === STAFF_SCRYPT_PARAMS_V1.saltLength
        && verifier.hash.length === STAFF_SCRYPT_PARAMS_V1.keyLength
    const target = usable ? verifier : await dummyStaffPasswordVerifierV1()
    const derived = await scryptAsync(candidate, target.salt, STAFF_SCRYPT_PARAMS_V1)
    const equal = derived.length === target.hash.length && timingSafeEqual(derived, target.hash)
    return usable && equal && candidate.length > 0
}

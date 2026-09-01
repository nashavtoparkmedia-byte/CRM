import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const INTEGRATION_ADMIN_SESSION_COOKIE = 'yoko_integration_admin_session'
export const INTEGRATION_ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60

const SESSION_AUDIENCE = 'yoko-gravity-integration-admin'
const SESSION_VERSION = 1
const MAX_CREDENTIAL_LENGTH = 4096

export interface IntegrationAdminCredentialConfig {
    username: string
    password: string
}

export interface IntegrationAdminEnvironment {
    ADMIN_USER?: string
    ADMIN_PASS?: string
}

interface IntegrationAdminSessionPayload {
    v: typeof SESSION_VERSION
    aud: typeof SESSION_AUDIENCE
    sub: string
    iat: number
    exp: number
}

/**
 * Resolve the already-provisioned project-admin credential used by the
 * production bot administration surface. There are deliberately no fallback
 * credentials: a missing, example, or weak placeholder value disables this
 * authentication lane instead of silently opening it.
 */
export function getIntegrationAdminCredentialConfig(
    env: IntegrationAdminEnvironment = process.env as unknown as IntegrationAdminEnvironment,
): IntegrationAdminCredentialConfig | null {
    const username = env.ADMIN_USER?.trim() ?? ''
    const password = env.ADMIN_PASS ?? ''
    const normalizedPassword = password.trim().toLowerCase()

    if (!username || username.length > 128) return null
    if (password.length < 12 || password.length > MAX_CREDENTIAL_LENGTH) return null
    if (
        normalizedPassword === 'admin123'
        || normalizedPassword === 'password'
        || normalizedPassword === 'changeme'
        || /(?:placeholder|replace[-_ ]?me|change[-_ ]?me|__generate)/i.test(normalizedPassword)
    ) {
        return null
    }

    return { username, password }
}

function constantTimeStringEqual(left: string, right: string): boolean {
    const leftDigest = createHash('sha256').update(left, 'utf8').digest()
    const rightDigest = createHash('sha256').update(right, 'utf8').digest()
    return timingSafeEqual(leftDigest, rightDigest)
}

export function verifyIntegrationAdminCredentials(
    suppliedUsername: unknown,
    suppliedPassword: unknown,
    env: IntegrationAdminEnvironment = process.env as unknown as IntegrationAdminEnvironment,
): boolean {
    const config = getIntegrationAdminCredentialConfig(env)
    if (!config) return false
    if (typeof suppliedUsername !== 'string' || typeof suppliedPassword !== 'string') return false
    if (suppliedUsername.length > MAX_CREDENTIAL_LENGTH || suppliedPassword.length > MAX_CREDENTIAL_LENGTH) {
        return false
    }

    // Evaluate both comparisons so a wrong username does not skip the password
    // work and create a useful timing distinction.
    const usernameMatches = constantTimeStringEqual(suppliedUsername, config.username)
    const passwordMatches = constantTimeStringEqual(suppliedPassword, config.password)
    return usernameMatches && passwordMatches
}

function signSessionPayload(encodedPayload: string, config: IntegrationAdminCredentialConfig): Buffer {
    return createHmac('sha256', config.password)
        .update(`${SESSION_AUDIENCE}\0${config.username}\0${encodedPayload}`, 'utf8')
        .digest()
}

export function issueIntegrationAdminSession(
    env: IntegrationAdminEnvironment = process.env as unknown as IntegrationAdminEnvironment,
    nowMs = Date.now(),
): string | null {
    const config = getIntegrationAdminCredentialConfig(env)
    if (!config) return null

    const issuedAt = Math.floor(nowMs / 1000)
    const payload: IntegrationAdminSessionPayload = {
        v: SESSION_VERSION,
        aud: SESSION_AUDIENCE,
        sub: config.username,
        iat: issuedAt,
        exp: issuedAt + INTEGRATION_ADMIN_SESSION_TTL_SECONDS,
    }
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const signature = signSessionPayload(encodedPayload, config).toString('base64url')
    return `${encodedPayload}.${signature}`
}

export function verifyIntegrationAdminSession(
    token: unknown,
    env: IntegrationAdminEnvironment = process.env as unknown as IntegrationAdminEnvironment,
    nowMs = Date.now(),
): boolean {
    const config = getIntegrationAdminCredentialConfig(env)
    if (!config || typeof token !== 'string' || token.length > MAX_CREDENTIAL_LENGTH) return false

    const tokenParts = token.split('.')
    if (tokenParts.length !== 2 || !tokenParts[0] || !tokenParts[1]) return false
    const [encodedPayload, encodedSignature] = tokenParts

    let suppliedSignature: Buffer
    let payload: IntegrationAdminSessionPayload
    try {
        suppliedSignature = Buffer.from(encodedSignature, 'base64url')
        payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
    } catch {
        return false
    }

    const expectedSignature = signSessionPayload(encodedPayload, config)
    if (
        suppliedSignature.length !== expectedSignature.length
        || !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
        return false
    }

    const nowSeconds = Math.floor(nowMs / 1000)
    return payload?.v === SESSION_VERSION
        && payload.aud === SESSION_AUDIENCE
        && payload.sub === config.username
        && Number.isInteger(payload.iat)
        && Number.isInteger(payload.exp)
        && payload.iat <= nowSeconds + 60
        && payload.exp > nowSeconds
        && payload.exp - payload.iat === INTEGRATION_ADMIN_SESSION_TTL_SECONDS
}

/** Accept only local settings/log destinations; never turn auth into a redirector. */
export function normalizeIntegrationAdminReturnTo(value: unknown): string {
    if (typeof value !== 'string' || value.length > 1024) return '/settings'
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/settings'

    try {
        const parsed = new URL(value, 'https://gravity.invalid')
        if (parsed.origin !== 'https://gravity.invalid') return '/settings'
        const allowed = parsed.pathname === '/settings'
            || parsed.pathname.startsWith('/settings/')
            || parsed.pathname === '/logs'
            || parsed.pathname === '/calls/campaigns'
            || parsed.pathname.startsWith('/calls/campaigns/')
        return allowed ? `${parsed.pathname}${parsed.search}` : '/settings'
    } catch {
        return '/settings'
    }
}

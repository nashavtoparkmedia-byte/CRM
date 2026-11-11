// @vitest-environment node
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
    issueMobileSession,
    mobileSessionBarrierEntryExpiryV1,
    mobileSessionBarrierEntryV1,
    mobileSessionBindingIdV1,
    verifyMobileSession,
    type MobileSessionEnvironment,
} from './mobile-session-credentials'

const ENV: MobileSessionEnvironment = { STAFF_SESSION_SECRET: 'fingerprint-staff-secret-0123456789abcdef' }
const ROTATED: MobileSessionEnvironment = { STAFF_SESSION_SECRET: 'rotated-staff-secret-0123456789abcdef00' }
const NOW = Date.UTC(2026, 8, 22, 12)
const EPOCH = 4

function sessionOf(env: MobileSessionEnvironment = ENV, operator = 'u1', device = 'device-1', nowMs = NOW) {
    const token = issueMobileSession(operator, device, EPOCH, env, nowMs)!
    return { token, principal: verifyMobileSession(token, env, nowMs)! }
}

function payloadOf(token: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))
}

/** A session signed exactly as the issuer signs, with the payload overridden. */
function signedSession(overrides: Record<string, unknown>): string {
    const payload = { ...payloadOf(issueMobileSession('u1', 'device-1', EPOCH, ENV, NOW)!), ...overrides }
    for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete payload[key]
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const key = createHmac('sha256', ENV.STAFF_SESSION_SECRET!)
        .update('yoko-mobile-session-key.v2', 'utf8')
        .digest()
    const signature = createHmac('sha256', key)
        .update(`yoko-gravity-mobile-shell\0${encoded}`, 'utf8')
        .digest('base64url')
    return `${encoded}.${signature}`
}

/** A correctly signed v2 payload without an instance id. */
function sessionWithoutInstanceId(): string {
    return signedSession({ sid: undefined })
}

describe('Mobile Push v1 session identity', () => {
    it('1. two sessions issued in the SAME SECOND for one device are different sessions', () => {
        // Same device, credential, epoch, operator and timestamps: only the
        // server-issued instance id separates them.
        const first = sessionOf()
        const second = sessionOf()
        const facts = ['op', 'uep', 'did', 'rev', 'iat', 'exp'] as const
        for (const fact of facts) expect(payloadOf(second.token)[fact]).toEqual(payloadOf(first.token)[fact])
        expect(second.principal.sessionInstanceId).not.toBe(first.principal.sessionInstanceId)
        expect(mobileSessionBindingIdV1(second.principal)).not.toBe(mobileSessionBindingIdV1(first.principal))
        expect(mobileSessionBarrierEntryV1(second.principal)).not.toBe(mobileSessionBarrierEntryV1(first.principal))
        // ... and they stay distinct however many are issued in that second.
        const ids = new Set(Array.from({ length: 50 }, () => sessionOf().principal.sessionInstanceId))
        expect(ids.size).toBe(50)
    })

    it('mints the instance id server-side: random, well formed, never client input', () => {
        const { token, principal } = sessionOf()
        expect(principal.sessionInstanceId).toMatch(/^[A-Za-z0-9_-]{22}$/)
        expect(payloadOf(token).sid).toBe(principal.sessionInstanceId)
        // It lives inside the signed payload, so an edit invalidates the session.
        const forged = { ...payloadOf(token), sid: 'AAAAAAAAAAAAAAAAAAAAAA' }
        const tampered = `${Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url')}.${token.split('.')[1]}`
        expect(verifyMobileSession(tampered, ENV, NOW)).toBeNull()
    })

    it('names the session from the instance id alone, so nothing about the session leaks into it', () => {
        const { principal } = sessionOf()
        const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
        expect(mobileSessionBindingIdV1(principal)).toBe(sha256(`yoko.mobile-push.session-binding.v3\0${principal.sessionInstanceId}`))
        expect(mobileSessionBindingIdV1(principal)).toMatch(/^[0-9a-f]{64}$/)
        // Stable for the life of the session: a second read is the same name.
        expect(mobileSessionBindingIdV1(principal)).toBe(mobileSessionBindingIdV1({ ...principal }))
        // The operator label is client-supplied and must not change it.
        expect(mobileSessionBindingIdV1({ ...principal, runtimeOperatorId: 'u9' })).toBe(mobileSessionBindingIdV1(principal))
    })

    it('6. every v2 session has an instance id: a signed payload without one is refused', () => {
        // Correctly signed with the v2 key, so only the sid rule can refuse it.
        expect(verifyMobileSession(sessionWithoutInstanceId(), ENV, NOW)).toBeNull()
        const { principal } = sessionOf()
        expect(mobileSessionBindingIdV1(principal)).toMatch(/^[0-9a-f]{64}$/)
        expect(mobileSessionBarrierEntryV1(principal)).not.toBeNull()
    })

    it('refuses a session whose instance id is malformed rather than ignoring it', () => {
        // Each of these is CORRECTLY SIGNED, so only the sid rule can refuse it.
        for (const sid of ['', 'short', 'x'.repeat(23), 'x'.repeat(21), 'has spaces and more!!!', 'contains/slash+plus==', 42, null, { nested: true }]) {
            const token = signedSession({ sid })
            expect(verifyMobileSession(token, ENV, NOW), `sid ${JSON.stringify(sid)} was accepted`).toBeNull()
        }
        // The well-formed one from the same helper is accepted, so the helper
        // itself signs correctly and the refusals above are about the sid.
        const good = signedSession({ sid: 'AAAAAAAAAAAAAAAAAAAAAA' })
        expect(verifyMobileSession(good, ENV, NOW)!.sessionInstanceId).toBe('AAAAAAAAAAAAAAAAAAAAAA')
    })

    it('7. a barrier entry carries its own expiry, so old entries can be dropped', () => {
        const { principal } = sessionOf()
        const entry = mobileSessionBarrierEntryV1(principal)!
        expect(entry).toBe(`${mobileSessionBindingIdV1(principal)}.${principal.expiresAtSeconds}`)
        expect(mobileSessionBarrierEntryExpiryV1(entry)).toBe(principal.expiresAtSeconds)
        expect(entry.length).toBeLessThanOrEqual(96)
        // Anything that is not one of ours is reported as such, never as live.
        for (const junk of ['', 'nonsense', `${'f'.repeat(64)}.`, `${'f'.repeat(63)}.123`, 'zz.123']) {
            expect(mobileSessionBarrierEntryExpiryV1(junk)).toBeNull()
        }
    })

    it('NEGATIVE: nothing a registration stores is derived from a secret', () => {
        // The stored subject is the employee's credential epoch, a counter:
        // independent of the signing secret and of any password.
        const original = sessionOf(ENV)
        const rotated = sessionOf(ROTATED)
        expect(rotated.token).not.toBe(original.token)
        expect(original.principal.credentialSubject).toBe(`staff-v2:${EPOCH}`)
        expect(rotated.principal.credentialSubject).toBe(original.principal.credentialSubject)
        expect(original.principal.credentialSubject).not.toContain(ENV.STAFF_SESSION_SECRET!)
        // The binding is a name for a random value, independent of the secret.
        const sameInstance = { ...rotated.principal, sessionInstanceId: original.principal.sessionInstanceId }
        expect(mobileSessionBindingIdV1(sameInstance)).toBe(mobileSessionBindingIdV1(original.principal))
    })
})

// @vitest-environment node
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
    currentMobilePushCredentialFactsV1,
    issueMobileSession,
    mobileSessionBindingIdV1,
    verifyMobileSession,
    type MobileSessionEnvironment,
} from './mobile-session-credentials'

const ENV: MobileSessionEnvironment = { MOBILE_ACCESS_USER: 'mobile-fingerprint', MOBILE_ACCESS_PASS: 'fingerprint-passphrase-01' }
const ROTATED: MobileSessionEnvironment = { ...ENV, MOBILE_ACCESS_PASS: 'rotated-passphrase-000002' }
const NOW = Date.UTC(2026, 8, 22, 12)

function sessionOf(env: MobileSessionEnvironment, operator = 'u1', device = 'device-1', nowMs = NOW) {
    const token = issueMobileSession(operator, device, env, nowMs)!
    return { token, principal: verifyMobileSession(token, env, nowMs)! }
}

describe('Mobile Push v1 session binding', () => {
    it('names one session: stable inside it, different after a new login', () => {
        const first = sessionOf(ENV)
        const later = sessionOf(ENV, 'u1', 'device-1', NOW + 60_000)
        const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
        // Computed independently from the session's own verified facts.
        expect(mobileSessionBindingIdV1(first.principal, '0')).toBe(sha256([
            'yoko.mobile-push.session-binding.v2',
            'device-1',
            'mobile-fingerprint',
            '0',
            String(first.principal.expiresAtSeconds),
        ].join('\0')))
        expect(mobileSessionBindingIdV1(first.principal, '0')).not.toBe(mobileSessionBindingIdV1(later.principal, '0'))
        expect(mobileSessionBindingIdV1(first.principal, '0')).toMatch(/^[0-9a-f]{64}$/)
        // A different device, operator generation or epoch is a different session.
        expect(mobileSessionBindingIdV1(sessionOf(ENV, 'u1', 'device-2').principal, '0')).not.toBe(mobileSessionBindingIdV1(first.principal, '0'))
        expect(mobileSessionBindingIdV1(first.principal, 'bumped')).not.toBe(mobileSessionBindingIdV1(first.principal, '0'))
    })

    it('ignores the unverified operator label, so a client cannot mint a new session identity', () => {
        // The label is client-supplied; if it changed the binding, a client
        // could step around the logout barrier by relabelling itself.
        const asU1 = sessionOf(ENV, 'u1')
        const asU9 = sessionOf(ENV, 'u9')
        expect(asU9.principal.runtimeOperatorId).toBe('u9')
        expect(mobileSessionBindingIdV1(asU9.principal, '0')).toBe(mobileSessionBindingIdV1(asU1.principal, '0'))
    })

    it('NEGATIVE: nothing a registration stores can verify a guess of MOBILE_ACCESS_PASS', () => {
        // Same session facts under two different passwords must produce
        // byte-identical stored values. Anything password-derived in the
        // database would be a fast offline verifier for password guesses,
        // because every other stored field is already known to whoever holds
        // the database — including enough to rebuild the session token.
        const original = sessionOf(ENV)
        const rotated = sessionOf(ROTATED)
        expect(rotated.token).not.toBe(original.token)
        expect(mobileSessionBindingIdV1(rotated.principal, '0')).toBe(mobileSessionBindingIdV1(original.principal, '0'))
        expect(currentMobilePushCredentialFactsV1(ROTATED)).toEqual(currentMobilePushCredentialFactsV1(ENV))
        // The stored facts themselves are the session's own non-secret claims.
        expect(rotated.principal).toEqual(original.principal)
    })

    it('exposes only the credential subject, and nothing at all when unprovisioned', () => {
        const facts = currentMobilePushCredentialFactsV1(ENV)!
        expect(Object.keys(facts)).toEqual(['credentialSubject'])
        expect(facts.credentialSubject).toBe('mobile-fingerprint')
        expect(JSON.stringify(facts)).not.toContain(ENV.MOBILE_ACCESS_PASS)
        expect(currentMobilePushCredentialFactsV1({})).toBeNull()
        expect(currentMobilePushCredentialFactsV1({ ...ENV, MOBILE_ACCESS_PASS: 'short' })).toBeNull()
    })
})

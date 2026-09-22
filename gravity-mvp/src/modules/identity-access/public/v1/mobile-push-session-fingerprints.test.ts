// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
    currentMobilePushCredentialFactsV1,
    issueMobileSession,
    mobileSessionBindingIdV1,
    type MobileSessionEnvironment,
} from './mobile-session-credentials'

const ENV: MobileSessionEnvironment = { MOBILE_ACCESS_USER: 'mobile-fingerprint', MOBILE_ACCESS_PASS: 'fingerprint-passphrase-01' }
const NOW = Date.UTC(2026, 8, 22, 12)

describe('Mobile Push v1 session fingerprints', () => {
    it('binds to one session: stable for the same token, different for a new login', () => {
        const first = issueMobileSession('u1', 'device-1', ENV, NOW)!
        const second = issueMobileSession('u1', 'device-1', ENV, NOW + 1000)!
        expect(mobileSessionBindingIdV1(first)).toBe(mobileSessionBindingIdV1(first))
        expect(mobileSessionBindingIdV1(first)).not.toBe(mobileSessionBindingIdV1(second))
        expect(mobileSessionBindingIdV1(first)).toMatch(/^[0-9a-f]{64}$/)
        expect(mobileSessionBindingIdV1(first)).not.toContain(first.split('.')[1])
    })

    it('fingerprints the signing key without exposing the credential', () => {
        const facts = currentMobilePushCredentialFactsV1(ENV)!
        expect(facts.credentialSubject).toBe('mobile-fingerprint')
        expect(facts.credentialKeyId).toMatch(/^[0-9a-f]{16}$/)
        expect(JSON.stringify(facts)).not.toContain(ENV.MOBILE_ACCESS_PASS)
        expect(Object.keys(facts).sort()).toEqual(['credentialKeyId', 'credentialSubject'])
    })

    it('changes the key id when the credential rotates, and is absent when unprovisioned', () => {
        const before = currentMobilePushCredentialFactsV1(ENV)!.credentialKeyId
        expect(currentMobilePushCredentialFactsV1({ ...ENV, MOBILE_ACCESS_PASS: 'rotated-passphrase-0002' })!.credentialKeyId).not.toBe(before)
        expect(currentMobilePushCredentialFactsV1({ ...ENV, MOBILE_ACCESS_USER: 'another-user' })!.credentialKeyId).not.toBe(before)
        expect(currentMobilePushCredentialFactsV1({})).toBeNull()
        expect(currentMobilePushCredentialFactsV1({ ...ENV, MOBILE_ACCESS_PASS: 'short' })).toBeNull()
    })
})

import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
    MOBILE_PUSH_CREDENTIAL_SUBJECT_PREFIX_V2,
    MOBILE_SESSION_TTL_SECONDS,
    getMobileSessionRevocationEpoch,
    isMobileSessionSigningConfigured,
    isSafeDeviceId,
    isSafeRuntimeOperatorId,
    issueMobileSession,
    normalizeMobileReturnTo,
    verifyMobileSession,
} from '@/modules/identity-access/public/v1/mobile-session-credentials'
import { issueIntegrationAdminSession, verifyIntegrationAdminSession }
    from '@/modules/identity-access/public/v1/integration-admin-credentials'
import { issueStaffSessionTokenV1, readStaffSessionTokenV1 } from '@/modules/identity-access/internal/staff-session-credentials'

/**
 * The v2 mobile session primitive (docs/design/mobile-personal-signin-v1.md
 * §2.2): signed under a key derived from STAFF_SESSION_SECRET with its own
 * label, carrying the verified employee and their credential epoch. The
 * shared MOBILE_ACCESS_USER / MOBILE_ACCESS_PASS are not read at all.
 */

const SECRET = 'staff-session-signing-key-for-tests-0123456789abcdef'
const env = { STAFF_SESSION_SECRET: SECRET }

const OPERATOR = 'u1'
const DEVICE = 'a1b2c3d4e5f6a7b8'
const EPOCH = 3
const NOW = Date.UTC(2026, 8, 11, 9, 0, 0)

describe('mobile session signing key', () => {
    test('fails closed without a valid staff secret: none, short, placeholder, or equal to another lane secret', () => {
        expect(isMobileSessionSigningConfigured({})).toBe(false)
        expect(issueMobileSession(OPERATOR, DEVICE, EPOCH, {})).toBeNull()
        for (const secret of ['short', 'x'.repeat(31), '__GENERATE_WITH_openssl_rand_base64_32__', 'replace-me-before-production-0123456789']) {
            expect(isMobileSessionSigningConfigured({ STAFF_SESSION_SECRET: secret })).toBe(false)
        }
        expect(isMobileSessionSigningConfigured({ STAFF_SESSION_SECRET: SECRET, ADMIN_PASS: SECRET })).toBe(false)
        expect(isMobileSessionSigningConfigured(env)).toBe(true)
    })

    test('the shared mobile credential no longer configures or signs anything', () => {
        const sharedOnly = { MOBILE_ACCESS_USER: 'mobile-operator', MOBILE_ACCESS_PASS: 'correct horse battery staple' } as Record<string, string>
        expect(isMobileSessionSigningConfigured(sharedOnly)).toBe(false)
        expect(issueMobileSession(OPERATOR, DEVICE, EPOCH, sharedOnly)).toBeNull()
        // A v1-style token signed with the shared credential's derived key is refused.
        const key = createHmac('sha256', sharedOnly.MOBILE_ACCESS_PASS).update('yoko-mobile-shell-session-key.v1\0mobile-operator', 'utf8').digest()
        const iat = Math.floor(NOW / 1000)
        const payload = Buffer.from(JSON.stringify({ v: 1, aud: 'yoko-gravity-mobile-shell', sub: 'mobile-operator', op: OPERATOR, did: DEVICE, rev: '0', iat, exp: iat + MOBILE_SESSION_TTL_SECONDS, sid: 'AAAAAAAAAAAAAAAAAAAAAA' })).toString('base64url')
        const signature = createHmac('sha256', key).update(`yoko-gravity-mobile-shell\0${payload}`, 'utf8').digest('base64url')
        expect(verifyMobileSession(`${payload}.${signature}`, { ...env, ...sharedOnly }, NOW)).toBeNull()
    })
})

describe('mobile session token v2', () => {
    test('round-trips the verified employee, their credential epoch and the device', () => {
        const token = issueMobileSession(OPERATOR, DEVICE, EPOCH, env, NOW)
        expect(token).toBeTypeOf('string')
        const principal = verifyMobileSession(token, env, NOW)
        expect(principal).toEqual({
            credentialSubject: `${MOBILE_PUSH_CREDENTIAL_SUBJECT_PREFIX_V2}${EPOCH}`,
            runtimeOperatorId: OPERATOR,
            staffEpoch: EPOCH,
            deviceId: DEVICE,
            expiresAtSeconds: Math.floor(NOW / 1000) + MOBILE_SESSION_TTL_SECONDS,
            sessionInstanceId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        })
        const second = verifyMobileSession(issueMobileSession(OPERATOR, DEVICE, EPOCH, env, NOW), env, NOW)
        expect(second!.sessionInstanceId).not.toBe(principal!.sessionInstanceId)
    })

    test('expires, and does not accept a session minted in the future', () => {
        const token = issueMobileSession(OPERATOR, DEVICE, EPOCH, env, NOW)
        expect(verifyMobileSession(token, env, NOW + (MOBILE_SESSION_TTL_SECONDS - 1) * 1000)).not.toBeNull()
        expect(verifyMobileSession(token, env, NOW + MOBILE_SESSION_TTL_SECONDS * 1000)).toBeNull()
        expect(verifyMobileSession(token, env, NOW - 10 * 60 * 1000)).toBeNull()
    })

    test('rotating the staff secret revokes every outstanding session', () => {
        const token = issueMobileSession(OPERATOR, DEVICE, EPOCH, env, NOW)
        expect(verifyMobileSession(token, { STAFF_SESSION_SECRET: `${SECRET}-rotated` }, NOW)).toBeNull()
    })

    test('raising the revocation epoch revokes every outstanding session', () => {
        expect(getMobileSessionRevocationEpoch({})).toBe('0')
        const token = issueMobileSession(OPERATOR, DEVICE, EPOCH, env, NOW)
        expect(verifyMobileSession(token, env, NOW)).not.toBeNull()
        const revoked = { ...env, MOBILE_SESSION_REVOCATION_EPOCH: '1' }
        expect(verifyMobileSession(token, revoked, NOW)).toBeNull()
        expect(verifyMobileSession(issueMobileSession(OPERATOR, DEVICE, EPOCH, revoked, NOW), revoked, NOW)).not.toBeNull()
    })

    test('rejects a tampered operator, epoch or signature, and malformed tokens', () => {
        const token = issueMobileSession(OPERATOR, DEVICE, EPOCH, env, NOW) as string
        const [payload, signature] = token.split('.')
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        for (const change of [{ op: 'u2' }, { uep: EPOCH + 1 }, { v: 1 }, { sid: undefined }]) {
            const forged = Buffer.from(JSON.stringify({ ...decoded, ...change }), 'utf8').toString('base64url')
            expect(verifyMobileSession(`${forged}.${signature}`, env, NOW)).toBeNull()
        }
        expect(verifyMobileSession(`${payload}.${signature.slice(0, -2)}AA`, env, NOW)).toBeNull()
        expect(verifyMobileSession(payload, env, NOW)).toBeNull()
        expect(verifyMobileSession(`${payload}.${signature}.extra`, env, NOW)).toBeNull()
        expect(verifyMobileSession('', env, NOW)).toBeNull()
        expect(verifyMobileSession(null, env, NOW)).toBeNull()
        expect(verifyMobileSession('x'.repeat(5000), env, NOW)).toBeNull()
    })

    test('mobile, staff and integration-admin tokens never verify in another lane', () => {
        const mobileToken = issueMobileSession(OPERATOR, DEVICE, EPOCH, env, NOW) as string
        const staffToken = issueStaffSessionTokenV1({ userId: OPERATOR, userEpoch: EPOCH }, env, NOW) as string
        expect(staffToken).toBeTypeOf('string')
        expect(verifyMobileSession(staffToken, env, NOW)).toBeNull()
        expect(readStaffSessionTokenV1(mobileToken, env, NOW)).toBeNull()
        const adminEnv = { ADMIN_USER: 'shared-name', ADMIN_PASS: 'another perfectly fine passphrase' }
        const adminToken = issueIntegrationAdminSession(adminEnv, NOW) as string
        expect(verifyIntegrationAdminSession(mobileToken, adminEnv, NOW)).toBe(false)
        expect(verifyMobileSession(adminToken, env, NOW)).toBeNull()
    })

    test('refuses to mint a session for an unsafe operator, device or epoch', () => {
        expect(isSafeRuntimeOperatorId('u1')).toBe(true)
        expect(isSafeRuntimeOperatorId('../u1')).toBe(false)
        expect(isSafeRuntimeOperatorId('')).toBe(false)
        expect(isSafeDeviceId(DEVICE)).toBe(true)
        expect(isSafeDeviceId('a b')).toBe(false)
        expect(isSafeDeviceId('x'.repeat(200))).toBe(false)
        expect(issueMobileSession('../u1', DEVICE, EPOCH, env, NOW)).toBeNull()
        expect(issueMobileSession(OPERATOR, 'a b', EPOCH, env, NOW)).toBeNull()
        for (const epoch of [-1, 1.5, Number.NaN, 2 ** 31]) expect(issueMobileSession(OPERATOR, DEVICE, epoch, env, NOW)).toBeNull()
    })
})

describe('mobile return-to normalisation', () => {
    test('keeps the two legitimate messenger destinations', () => {
        expect(normalizeMobileReturnTo('/messages')).toBe('/messages')
        expect(normalizeMobileReturnTo('/messages?id=abc&channel=tg')).toBe('/messages?id=abc&channel=tg')
        expect(normalizeMobileReturnTo('/messages/open?chat=abc')).toBe('/messages/open?chat=abc')
    })

    test('never becomes an open redirector', () => {
        expect(normalizeMobileReturnTo('https://evil.example/')).toBe('/messages')
        expect(normalizeMobileReturnTo('//evil.example/')).toBe('/messages')
        expect(normalizeMobileReturnTo('/\\evil.example')).toBe('/messages')
        expect(normalizeMobileReturnTo('/settings/integrations/access')).toBe('/messages')
        expect(normalizeMobileReturnTo('/users')).toBe('/messages')
        expect(normalizeMobileReturnTo(undefined)).toBe('/messages')
        expect(normalizeMobileReturnTo('x'.repeat(2000))).toBe('/messages')
    })

    test('strips the parameters that would make the CRM write on a GET', () => {
        // /messages?phone= runs prisma.chat.create server-side. A login
        // redirect must never be able to reach it.
        expect(normalizeMobileReturnTo('/messages?phone=%2B79990000000')).toBe('/messages')
        expect(normalizeMobileReturnTo('/messages?id=abc&phone=%2B7999&driver=d1')).toBe('/messages?id=abc')
    })
})

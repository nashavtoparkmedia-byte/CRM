import { describe, expect, test } from 'vitest'
import {
    MOBILE_SESSION_TTL_SECONDS,
    getMobileAccessCredentialConfig,
    getMobileSessionRevocationEpoch,
    isSafeDeviceId,
    isSafeRuntimeOperatorId,
    issueMobileSession,
    normalizeMobileReturnTo,
    verifyMobileAccessCredentials,
    verifyMobileSession,
} from '@/modules/identity-access/public/v1/mobile-session-credentials'
import { issueIntegrationAdminSession, verifyIntegrationAdminSession }
    from '@/modules/identity-access/public/v1/integration-admin-credentials'

const dedicatedEnv = {
    MOBILE_ACCESS_USER: 'mobile-operator',
    MOBILE_ACCESS_PASS: 'correct horse battery staple',
}

const projectAdminEnv = {
    ADMIN_USER: 'project-operator',
    ADMIN_PASS: 'another perfectly fine passphrase',
}

const OPERATOR = 'u1'
const DEVICE = 'a1b2c3d4e5f6a7b8'
const NOW = Date.UTC(2026, 8, 11, 9, 0, 0)

describe('mobile access credential resolution', () => {
    test('fails closed with no credential, a short one, or a placeholder', () => {
        expect(getMobileAccessCredentialConfig({})).toBeNull()
        expect(getMobileAccessCredentialConfig({ MOBILE_ACCESS_USER: 'a', MOBILE_ACCESS_PASS: 'short' })).toBeNull()
        for (const password of [
            'admin123',
            'password',
            'changeme',
            '__GENERATE_WITH_openssl_rand_base64_24__',
            'replace-me-before-production',
            'placeholder-mobile-password',
        ]) {
            expect(getMobileAccessCredentialConfig({ MOBILE_ACCESS_USER: 'a', MOBILE_ACCESS_PASS: password })).toBeNull()
            expect(getMobileAccessCredentialConfig({ ADMIN_USER: 'a', ADMIN_PASS: password })).toBeNull()
        }
        expect(issueMobileSession(OPERATOR, DEVICE, {})).toBeNull()
    })

    test('prefers a dedicated mobile credential over the project administrator one', () => {
        const both = { ...dedicatedEnv, ...projectAdminEnv }
        expect(getMobileAccessCredentialConfig(both)?.source).toBe('mobile_access')
        expect(getMobileAccessCredentialConfig(projectAdminEnv)?.source).toBe('project_admin')
        // The fallback is what makes the gate real before an operations task
        // provisions a dedicated credential.
        expect(verifyMobileAccessCredentials('project-operator', 'another perfectly fine passphrase', projectAdminEnv)).toBe(true)
        // …and the dedicated credential takes over once it exists.
        expect(verifyMobileAccessCredentials('project-operator', 'another perfectly fine passphrase', both)).toBe(false)
    })

    test('requires both halves of the credential', () => {
        expect(verifyMobileAccessCredentials('mobile-operator', 'correct horse battery staple', dedicatedEnv)).toBe(true)
        expect(verifyMobileAccessCredentials('wrong-user', 'correct horse battery staple', dedicatedEnv)).toBe(false)
        expect(verifyMobileAccessCredentials('mobile-operator', 'wrong passphrase entirely', dedicatedEnv)).toBe(false)
        expect(verifyMobileAccessCredentials(undefined, undefined, dedicatedEnv)).toBe(false)
        expect(verifyMobileAccessCredentials(null, 12345, dedicatedEnv)).toBe(false)
    })
})

describe('mobile session token', () => {
    test('round-trips the proven credential, the operator and the device', () => {
        const token = issueMobileSession(OPERATOR, DEVICE, dedicatedEnv, NOW)
        expect(token).toBeTypeOf('string')
        const principal = verifyMobileSession(token, dedicatedEnv, NOW)
        expect(principal).toEqual({
            credentialSubject: 'mobile-operator',
            runtimeOperatorId: OPERATOR,
            deviceId: DEVICE,
            expiresAtSeconds: Math.floor(NOW / 1000) + MOBILE_SESSION_TTL_SECONDS,
        })
    })

    test('expires, and does not accept a session minted in the future', () => {
        const token = issueMobileSession(OPERATOR, DEVICE, dedicatedEnv, NOW)
        expect(verifyMobileSession(token, dedicatedEnv, NOW + (MOBILE_SESSION_TTL_SECONDS - 1) * 1000)).not.toBeNull()
        expect(verifyMobileSession(token, dedicatedEnv, NOW + MOBILE_SESSION_TTL_SECONDS * 1000)).toBeNull()
        expect(verifyMobileSession(token, dedicatedEnv, NOW - 10 * 60 * 1000)).toBeNull()
    })

    test('rotating the credential revokes every outstanding session', () => {
        const token = issueMobileSession(OPERATOR, DEVICE, dedicatedEnv, NOW)
        const rotated = { ...dedicatedEnv, MOBILE_ACCESS_PASS: 'a different long passphrase' }
        expect(verifyMobileSession(token, rotated, NOW)).toBeNull()
    })

    test('raising the revocation epoch revokes every outstanding session', () => {
        expect(getMobileSessionRevocationEpoch({})).toBe('0')
        const token = issueMobileSession(OPERATOR, DEVICE, dedicatedEnv, NOW)
        expect(verifyMobileSession(token, dedicatedEnv, NOW)).not.toBeNull()
        const revoked = { ...dedicatedEnv, MOBILE_SESSION_REVOCATION_EPOCH: '1' }
        expect(verifyMobileSession(token, revoked, NOW)).toBeNull()
        // A session issued after the bump is valid again, so revocation is a
        // cut-off rather than a permanent lockout.
        const reissued = issueMobileSession(OPERATOR, DEVICE, revoked, NOW)
        expect(verifyMobileSession(reissued, revoked, NOW)).not.toBeNull()
    })

    test('rejects a tampered payload, a tampered signature and a malformed token', () => {
        const token = issueMobileSession(OPERATOR, DEVICE, dedicatedEnv, NOW) as string
        const [payload, signature] = token.split('.')

        // Re-encode the payload claiming a different operator, keeping the
        // original signature: this is the attack the unsigned crm_user_id
        // cookie has no answer for.
        const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        const forged = Buffer.from(JSON.stringify({ ...decoded, op: 'u2' }), 'utf8').toString('base64url')
        expect(verifyMobileSession(`${forged}.${signature}`, dedicatedEnv, NOW)).toBeNull()

        expect(verifyMobileSession(`${payload}.${signature.slice(0, -2)}AA`, dedicatedEnv, NOW)).toBeNull()
        expect(verifyMobileSession(payload, dedicatedEnv, NOW)).toBeNull()
        expect(verifyMobileSession(`${payload}.${signature}.extra`, dedicatedEnv, NOW)).toBeNull()
        expect(verifyMobileSession('', dedicatedEnv, NOW)).toBeNull()
        expect(verifyMobileSession(null, dedicatedEnv, NOW)).toBeNull()
        expect(verifyMobileSession('x'.repeat(5000), dedicatedEnv, NOW)).toBeNull()
    })

    test('mobile and integration-admin tokens never verify in the other lane', () => {
        const sharedEnv = { ADMIN_USER: 'project-operator', ADMIN_PASS: 'another perfectly fine passphrase' }
        const mobileToken = issueMobileSession(OPERATOR, DEVICE, sharedEnv, NOW) as string
        const adminToken = issueIntegrationAdminSession(sharedEnv, NOW) as string

        expect(verifyIntegrationAdminSession(mobileToken, sharedEnv, NOW)).toBe(false)
        expect(verifyMobileSession(adminToken, sharedEnv, NOW)).toBeNull()
    })

    test('refuses to mint a session for an unsafe operator or device identifier', () => {
        expect(isSafeRuntimeOperatorId('u1')).toBe(true)
        expect(isSafeRuntimeOperatorId('../u1')).toBe(false)
        expect(isSafeRuntimeOperatorId('')).toBe(false)
        expect(isSafeDeviceId(DEVICE)).toBe(true)
        expect(isSafeDeviceId('a b')).toBe(false)
        expect(isSafeDeviceId('x'.repeat(200))).toBe(false)

        expect(issueMobileSession('../u1', DEVICE, dedicatedEnv, NOW)).toBeNull()
        expect(issueMobileSession(OPERATOR, 'a b', dedicatedEnv, NOW)).toBeNull()
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

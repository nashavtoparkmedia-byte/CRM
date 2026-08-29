import { describe, expect, test } from 'vitest'
import {
    getIntegrationAdminCredentialConfig,
    INTEGRATION_ADMIN_SESSION_TTL_SECONDS,
    issueIntegrationAdminSession,
    normalizeIntegrationAdminReturnTo,
    verifyIntegrationAdminCredentials,
    verifyIntegrationAdminSession,
} from '@/modules/identity-access/public/v1/integration-admin-credentials'

const configuredEnv = {
    ADMIN_USER: 'project-operator',
    ADMIN_PASS: 'correct horse battery staple',
}

describe('integration administrator authentication', () => {
    test('fails closed when the production capability is absent or a placeholder', () => {
        expect(getIntegrationAdminCredentialConfig({})).toBeNull()
        expect(getIntegrationAdminCredentialConfig({ ADMIN_USER: 'admin', ADMIN_PASS: 'admin123' })).toBeNull()
        for (const password of [
            'password',
            'changeme',
            '__GENERATE_WITH_openssl_rand_base64_24__',
            'replace-me-before-production',
            'placeholder-admin-password',
        ]) {
            expect(getIntegrationAdminCredentialConfig({ ADMIN_USER: 'admin', ADMIN_PASS: password })).toBeNull()
        }
        expect(issueIntegrationAdminSession({})).toBeNull()
    })

    test('requires possession of both configured credential components', () => {
        expect(verifyIntegrationAdminCredentials('project-operator', 'correct horse battery staple', configuredEnv)).toBe(true)
        expect(verifyIntegrationAdminCredentials('wrong-user', 'correct horse battery staple', configuredEnv)).toBe(false)
        expect(verifyIntegrationAdminCredentials('project-operator', 'wrong password value', configuredEnv)).toBe(false)
        expect(verifyIntegrationAdminCredentials(undefined, undefined, configuredEnv)).toBe(false)
    })

    test('issues a bounded signed session and rejects expiry, tampering, and rotation', () => {
        const now = Date.UTC(2026, 7, 10, 12, 0, 0)
        const token = issueIntegrationAdminSession(configuredEnv, now)
        expect(token).toBeTypeOf('string')
        expect(verifyIntegrationAdminSession(token, configuredEnv, now)).toBe(true)
        expect(verifyIntegrationAdminSession(
            token,
            configuredEnv,
            now + INTEGRATION_ADMIN_SESSION_TTL_SECONDS * 1000,
        )).toBe(false)

        const [payload, signature] = token!.split('.')
        const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`
        expect(verifyIntegrationAdminSession(`${tamperedPayload}.${signature}`, configuredEnv, now)).toBe(false)
        expect(verifyIntegrationAdminSession(`${payload}.${signature.slice(0, -1)}A`, configuredEnv, now)).toBe(false)
        expect(verifyIntegrationAdminSession(token, {
            ...configuredEnv,
            ADMIN_PASS: 'rotated credential with enough entropy',
        }, now)).toBe(false)
    })

    test('never accepts crm identity data as authentication input', () => {
        const fakeIdentityOnly = { ADMIN_USER: undefined, ADMIN_PASS: undefined, crm_user_id: 'u3' }
        expect(getIntegrationAdminCredentialConfig(fakeIdentityOnly)).toBeNull()
        expect(verifyIntegrationAdminCredentials('u3', 'u3', fakeIdentityOnly)).toBe(false)
        expect(verifyIntegrationAdminSession('u3.fake', fakeIdentityOnly)).toBe(false)
    })

    test('normalizes return targets to a narrow same-origin allowlist', () => {
        expect(normalizeIntegrationAdminReturnTo('/settings/integrations/telegram?tab=login')).toBe('/settings/integrations/telegram?tab=login')
        expect(normalizeIntegrationAdminReturnTo('/logs')).toBe('/logs')
        expect(normalizeIntegrationAdminReturnTo('https://attacker.invalid/')).toBe('/settings')
        expect(normalizeIntegrationAdminReturnTo('//attacker.invalid/')).toBe('/settings')
        expect(normalizeIntegrationAdminReturnTo('/messages')).toBe('/settings')
        expect(normalizeIntegrationAdminReturnTo('/settings\\evil')).toBe('/settings')
    })
})

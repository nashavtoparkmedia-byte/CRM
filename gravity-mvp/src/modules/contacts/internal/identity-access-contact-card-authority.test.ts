import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeEach, describe, expect, test, vi } from 'vitest'

const { getIntegrationAdminPrincipal } = vi.hoisted(() => ({ getIntegrationAdminPrincipal: vi.fn() }))
vi.mock('@/modules/identity-access/public/v1', () => ({ getIntegrationAdminPrincipal }))

import { identityAccessContactCardAuthorityV1 as authority } from './identity-access-contact-card-authority'

const ADMIN = { id: 'identity-access:integration-admin-session', kind: 'integration_admin_session' }

beforeEach(() => {
  getIntegrationAdminPrincipal.mockReset()
})

describe('Contact card production authority', () => {
  test('without a verified integration-admin session there is no principal', async () => {
    getIntegrationAdminPrincipal.mockResolvedValue(null)
    expect(await authority.currentPrincipal()).toBeNull()
  })

  test('a verified session yields only its kind', async () => {
    getIntegrationAdminPrincipal.mockResolvedValue(ADMIN)
    expect(await authority.currentPrincipal()).toEqual({ kind: 'integration_admin_session' })
  })

  test('the verified integration-admin principal may read any conversation and Contact', async () => {
    expect(await authority.mayReadConversation({ kind: 'integration_admin_session' }, 'chat-1')).toBe(true)
    expect(await authority.mayReadContact({ kind: 'integration_admin_session' }, 'contact-a')).toBe(true)
  })

  test.each(['browser_operator', 'mobile_session', 'crm_user', 'integration_admin', ''])(
    'any other principal kind (%s) may read nothing',
    async kind => {
      expect(await authority.mayReadConversation({ kind }, 'chat-1')).toBe(false)
      expect(await authority.mayReadContact({ kind }, 'contact-a')).toBe(false)
    },
  )

  test('the binding reads no client-held identity: no crm_user_id, user service, cookie or header access in its code', () => {
    const code = readFileSync(join(process.cwd(), 'src/modules/contacts/internal/identity-access-contact-card-authority.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    for (const forbidden of ['crm_user_id', 'getCurrentUser', 'user-service', 'cookies(', 'headers(', 'getMobileSessionPrincipalV1', 'hasMobileSessionV1']) {
      expect(code).not.toContain(forbidden)
    }
    expect(code).toContain('getIntegrationAdminPrincipal()')
  })
})

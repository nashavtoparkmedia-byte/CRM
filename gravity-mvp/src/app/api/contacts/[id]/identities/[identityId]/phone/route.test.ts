import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ manage: vi.fn(), principal: vi.fn() }))

vi.mock('@/modules/contacts/public/v1', () => ({
  manageContactPhoneEvidenceV1: mocks.manage,
}))
vi.mock('@/modules/identity-access/public/v1', async importOriginal => ({
  ...await importOriginal<typeof import('@/modules/identity-access/public/v1')>(),
  getIntegrationAdminPrincipal: mocks.principal,
}))

import { POST } from './route'

const context = {
  params: Promise.resolve({ id: 'contact-1', identityId: 'identity-1' }),
}

function request(origin = 'https://crm.example') {
  return new NextRequest(
    'https://crm.example/api/contacts/contact-1/identities/identity-1/phone',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'crm.example',
        origin,
        'x-crm-user-id': 'forged-header-actor',
      },
      body: JSON.stringify({
        phoneId: 'phone-1',
        actor: 'forged-body-actor',
        basis: 'manual association',
      }),
    },
  )
}

describe('manual identity-phone association authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.principal.mockResolvedValue({
      id: 'identity-access:integration-admin-session',
      kind: 'integration_admin_session',
    })
  })

  test('rejects unsigned and cross-origin requests before mutation', async () => {
    mocks.principal.mockResolvedValueOnce(null)

    const unauthorized = await POST(request(), context)
    const crossOrigin = await POST(request('https://attacker.example'), context)

    expect(unauthorized.status).toBe(401)
    expect(crossOrigin.status).toBe(403)
    expect(mocks.principal).toHaveBeenCalledTimes(1)
    expect(mocks.manage).not.toHaveBeenCalled()
  })

  test('ignores caller actor selectors and uses the signed principal', async () => {
    mocks.manage.mockResolvedValue({ auditId: 'audit-1' })

    expect((await POST(request(), context)).status).toBe(200)
    expect(mocks.manage).toHaveBeenCalledWith({
      operation: 'attach_identity',
      contactId: 'contact-1',
      identityId: 'identity-1',
      phoneId: 'phone-1',
      actor: 'identity-access:integration-admin-session',
      basis: 'manual association',
    })
  })
})

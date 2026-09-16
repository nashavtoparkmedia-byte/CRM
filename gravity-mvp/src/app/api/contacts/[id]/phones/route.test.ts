import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  manage: vi.fn(),
  findPhone: vi.fn(),
  principal: vi.fn(),
}))

vi.mock('@/modules/contacts/public/v1', () => ({
  contactOwnershipBusyResultV1: () => null,
  manageContactPhoneEvidenceV1: mocks.manage,
}))
vi.mock('@/lib/prisma', () => ({
  prisma: { contactPhone: { findUnique: mocks.findPhone } },
}))
vi.mock('@/modules/identity-access/public/v1', async importOriginal => ({
  ...await importOriginal<typeof import('@/modules/identity-access/public/v1')>(),
  getIntegrationAdminPrincipal: mocks.principal,
}))

import { POST } from './route'

const context = { params: Promise.resolve({ id: 'contact-1' }) }

function request(origin = 'https://crm.example') {
  return new NextRequest('https://crm.example/api/contacts/contact-1/phones', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: 'crm.example',
      origin,
      'x-crm-user-id': 'forged-header-actor',
    },
    body: JSON.stringify({
      phone: '+7 999 000-00-01',
      isPrimary: true,
      actor: 'forged-body-actor',
      basis: 'operator supplied basis',
    }),
  })
}

describe('manual Contact phone route authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.principal.mockResolvedValue({
      id: 'identity-access:integration-admin-session',
      kind: 'integration_admin_session',
    })
  })

  test('rejects unsigned and cross-origin requests with zero Contact mutation or read', async () => {
    mocks.principal.mockResolvedValueOnce(null)

    const unauthorized = await POST(request(), context)
    const crossOrigin = await POST(request('https://attacker.example'), context)

    expect(unauthorized.status).toBe(401)
    expect(crossOrigin.status).toBe(403)
    expect(mocks.principal).toHaveBeenCalledTimes(1)
    expect(mocks.manage).not.toHaveBeenCalled()
    expect(mocks.findPhone).not.toHaveBeenCalled()
  })

  test('uses only the signed principal as the audit actor', async () => {
    mocks.manage.mockResolvedValue({ phoneId: 'phone-1' })
    mocks.findPhone.mockResolvedValue({ id: 'phone-1', phone: '+79990000001' })

    const response = await POST(request(), context)

    expect(response.status).toBe(201)
    expect(mocks.manage).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'add_or_verify',
      contactId: 'contact-1',
      actor: 'identity-access:integration-admin-session',
      basis: 'operator supplied basis',
    }))
  })
})

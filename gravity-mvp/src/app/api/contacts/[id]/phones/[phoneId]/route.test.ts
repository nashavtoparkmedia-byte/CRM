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

import { DELETE, PATCH } from './route'

const context = { params: Promise.resolve({ id: 'contact-1', phoneId: 'phone-1' }) }

function request(method: 'PATCH' | 'DELETE', origin = 'https://crm.example') {
  return new NextRequest('https://crm.example/api/contacts/contact-1/phones/phone-1', {
    method,
    headers: {
      'content-type': 'application/json',
      host: 'crm.example',
      origin,
      'x-crm-user-id': 'forged-header-actor',
    },
    ...(method === 'PATCH' ? {
      body: JSON.stringify({
        actor: 'forged-body-actor',
        basis: 'manual correction',
        isPrimary: true,
      }),
    } : {}),
  })
}

async function invoke(method: 'PATCH' | 'DELETE', origin = 'https://crm.example') {
  return method === 'PATCH'
    ? await PATCH(request(method, origin), context)
    : await DELETE(request(method, origin), context)
}

describe('manual Contact phone item authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.principal.mockResolvedValue({
      id: 'identity-access:integration-admin-session',
      kind: 'integration_admin_session',
    })
  })

  test.each(['PATCH', 'DELETE'] as const)(
    'rejects unsigned %s before mutation or read',
    async method => {
      mocks.principal.mockResolvedValue(null)

      expect((await invoke(method)).status).toBe(401)
      expect(mocks.manage).not.toHaveBeenCalled()
      expect(mocks.findPhone).not.toHaveBeenCalled()
    },
  )

  test.each(['PATCH', 'DELETE'] as const)(
    'rejects cross-origin %s before authorization, mutation, or read',
    async method => {
      expect((await invoke(method, 'https://attacker.example')).status).toBe(403)
      expect(mocks.principal).not.toHaveBeenCalled()
      expect(mocks.manage).not.toHaveBeenCalled()
      expect(mocks.findPhone).not.toHaveBeenCalled()
    },
  )

  test('uses only the signed actor for PATCH', async () => {
    mocks.manage.mockResolvedValue({ auditId: 'audit-1' })
    mocks.findPhone.mockResolvedValue({ id: 'phone-1' })

    expect((await invoke('PATCH')).status).toBe(200)
    expect(mocks.manage).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'identity-access:integration-admin-session',
      basis: 'manual correction',
      makePrimary: true,
    }))
  })

  test('uses only the signed actor for DELETE', async () => {
    mocks.manage.mockResolvedValue({ auditId: 'audit-1' })

    expect((await invoke('DELETE')).status).toBe(200)
    expect(mocks.manage).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'identity-access:integration-admin-session',
      basis: 'manual removal',
    }))
  })
})

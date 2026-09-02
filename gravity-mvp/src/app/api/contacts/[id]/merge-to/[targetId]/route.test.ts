import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ merge: vi.fn(), principal: vi.fn() }))

vi.mock('@/lib/ContactMergeService', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/ContactMergeService')>(),
  ContactMergeService: { mergeContactToContact: mocks.merge },
}))
vi.mock('@/modules/identity-access/public/v1', async importOriginal => ({
  ...await importOriginal<typeof import('@/modules/identity-access/public/v1')>(),
  getIntegrationAdminPrincipal: mocks.principal,
}))

import { POST } from './route'

const context = { params: Promise.resolve({ id: 'contact-source', targetId: 'contact-target' }) }

function request(origin = 'https://crm.example') {
  return new NextRequest(
    'https://crm.example/api/contacts/contact-source/merge-to/contact-target',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'crm.example',
        origin,
        'x-crm-user-id': 'forged-header-actor',
      },
      body: JSON.stringify({ mergedBy: 'forged-body-actor' }),
    },
  )
}

describe('manual Contact merge authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.principal.mockResolvedValue({
      id: 'identity-access:integration-admin-session',
      kind: 'integration_admin_session',
    })
  })

  test('rejects unsigned and cross-origin merges before mutation', async () => {
    mocks.principal.mockResolvedValueOnce(null)

    const unauthorized = await POST(request(), context)
    const crossOrigin = await POST(request('https://attacker.example'), context)

    expect(unauthorized.status).toBe(401)
    expect(crossOrigin.status).toBe(403)
    expect(mocks.principal).toHaveBeenCalledTimes(1)
    expect(mocks.merge).not.toHaveBeenCalled()
  })

  test('derives mergedBy only from the signed principal', async () => {
    mocks.merge.mockResolvedValue({ id: 'merge-1', survivorId: 'contact-target' })

    expect((await POST(request(), context)).status).toBe(200)
    expect(mocks.merge).toHaveBeenCalledWith(
      'contact-source',
      'contact-target',
      'identity-access:integration-admin-session',
    )
  })
})

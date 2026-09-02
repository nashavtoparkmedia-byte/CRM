import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ recover: vi.fn(), principal: vi.fn() }))

vi.mock('@/infrastructure/contact-merge-composition', () => ({
  mergeContactsV1: { recover: mocks.recover },
}))
vi.mock('@/modules/identity-access/public/v1', async importOriginal => ({
  ...await importOriginal<typeof import('@/modules/identity-access/public/v1')>(),
  getIntegrationAdminPrincipal: mocks.principal,
}))

import { POST } from './route'

describe('automated Contact merge recovery route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.principal.mockResolvedValue({
      id: 'identity-access:integration-admin-session',
      kind: 'integration_admin_session',
    })
  })

  test('rejects unsigned and cross-origin recovery before the owner command', async () => {
    const makeRequest = (origin: string) => new NextRequest(
      'https://crm.example/api/contact-merges/merge-1/recover',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'crm.example', origin },
        body: JSON.stringify({ requestedBy: 'forged-operator' }),
      },
    )
    mocks.principal.mockResolvedValueOnce(null)

    const unauthorized = await POST(makeRequest('https://crm.example'), {
      params: Promise.resolve({ id: 'merge-1' }),
    })
    const crossOrigin = await POST(makeRequest('https://attacker.example'), {
      params: Promise.resolve({ id: 'merge-1' }),
    })

    expect(unauthorized.status).toBe(401)
    expect(crossOrigin.status).toBe(403)
    expect(mocks.principal).toHaveBeenCalledTimes(1)
    expect(mocks.recover).not.toHaveBeenCalled()
  })

  test('reports an idempotent recovery replay as successful', async () => {
    mocks.recover.mockResolvedValue({
      status: 'already_recovered',
      mergeId: 'merge-1',
    })
    const response = await POST(
      new NextRequest('https://crm.example/api/contact-merges/merge-1/recover', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'crm.example',
          origin: 'https://crm.example',
          'x-crm-user-id': 'forged-header-actor',
        },
        body: JSON.stringify({ requestedBy: 'forged-body-actor' }),
      }),
      { params: Promise.resolve({ id: 'merge-1' }) },
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'already_recovered',
      mergeId: 'merge-1',
    })
    expect(mocks.recover).toHaveBeenCalledWith(expect.objectContaining({
      mergeId: 'merge-1',
      requestedBy: 'identity-access:integration-admin-session',
    }))
  })
})

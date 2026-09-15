import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  reconcile: vi.fn(),
  principal: vi.fn(),
}))

vi.mock('@/modules/fleet-operations/public/v1', () => ({
  searchYandexParksByDriverQueryV1: mocks.search,
}))
vi.mock('@/modules/platform-shell/public/v1', () => ({
  reconcileYandexFleetWithAutomaticMergeV1: mocks.reconcile,
}))
vi.mock('@/modules/identity-access/public/v1', async importOriginal => ({
  ...await importOriginal<typeof import('@/modules/identity-access/public/v1')>(),
  getIntegrationAdminPrincipal: mocks.principal,
}))

import { RECONCILE_YANDEX_FLEET_COMMAND_V1 } from '@/contracts/fleet-operations/v1'
import { GET, POST } from './route'

const ROUTE = 'https://crm.example/api/monitoring/fleet-check/driver-person'

function postRequest(body: Record<string, unknown>, origin: string | null = 'https://crm.example') {
  const headers: Record<string, string> = { 'content-type': 'application/json', host: 'crm.example' }
  if (origin !== null) headers.origin = origin
  return new NextRequest(ROUTE, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function getRequest(query: string) {
  return new NextRequest(`${ROUTE}?query=${encodeURIComponent(query)}`, { method: 'GET' })
}

describe('fleet-check driver-person follow-up authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.search.mockResolvedValue({ clusters: [], errors: [], partial: false })
    mocks.reconcile.mockResolvedValue({ clusters: [], errors: [], partial: false })
    mocks.principal.mockResolvedValue({
      id: 'identity-access:integration-admin-session',
      kind: 'integration_admin_session',
    })
  })

  test('rejects unsigned and cross-origin follow-up before any reconciliation or merge', async () => {
    mocks.principal.mockResolvedValueOnce(null)

    const unauthorized = await POST(postRequest({ query: '+7 999 000-00-01' }))
    const crossOrigin = await POST(postRequest({ query: '+7 999 000-00-01' }, 'https://attacker.example'))

    expect(unauthorized.status).toBe(401)
    expect(crossOrigin.status).toBe(403)
    expect(mocks.principal).toHaveBeenCalledTimes(1)
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(mocks.search).not.toHaveBeenCalled()
  })

  test('rejects a request without an origin before consulting authorization', async () => {
    const response = await POST(postRequest({ query: '+7 999 000-00-01' }, null))

    expect(response.status).toBe(403)
    expect(mocks.principal).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  test('runs confirmation follow-up reconciliation only for a signed principal', async () => {
    const response = await POST(postRequest({ query: '1234567890' }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      reconciliation: { clusters: [], errors: [], partial: false },
    })
    expect(mocks.reconcile).toHaveBeenCalledTimes(1)
    expect(mocks.reconcile).toHaveBeenCalledWith({
      contract: RECONCILE_YANDEX_FLEET_COMMAND_V1,
      mode: 'confirmation_followup',
      query: '1234567890',
    })
  })

  test('validates the query only after authorization and never reconciles a short query', async () => {
    const response = await POST(postRequest({ query: 'ab' }))

    expect(response.status).toBe(400)
    expect(mocks.principal).toHaveBeenCalledTimes(1)
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  test('keeps the operator park search on GET free of reconciliation follow-up and merges', async () => {
    mocks.principal.mockResolvedValue(null)

    const response = await GET(getRequest('Иванов'))

    expect(response.status).toBe(200)
    expect(mocks.search).toHaveBeenCalledWith('Иванов')
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })
})

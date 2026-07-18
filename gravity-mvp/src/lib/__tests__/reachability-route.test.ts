import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

const serviceMock = vi.hoisted(() => ({
  resolveReachabilityIdentity: vi.fn(),
  getProviderConnectionHealth: vi.fn(),
  updateReachability: vi.fn(),
}))
const whatsappMock = vi.hoisted(() => ({
  checkReachability: vi.fn(),
}))
vi.mock('@/lib/ReachabilityService', () => serviceMock)
vi.mock('@/lib/whatsapp/WhatsAppService', () => whatsappMock)

import { POST } from '@/app/api/channels/check-reachability/route'
import { resetReachabilityDecisionCacheForTests } from '@/lib/reachability-decision-cache'

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/channels/check-reachability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('canonical reachability refresh decision route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetReachabilityDecisionCacheForTests()
    serviceMock.getProviderConnectionHealth.mockResolvedValue('connected')
    serviceMock.updateReachability.mockResolvedValue(undefined)
  })

  test('fresh persisted account state performs no external provider request', async () => {
    const checkedAt = new Date(Date.now() - 60_000)
    serviceMock.resolveReachabilityIdentity.mockResolvedValue({
      kind: 'matched',
      identity: {
        id: 'identity-1',
        reachabilityStatus: 'confirmed',
        reachabilityCheckedAt: checkedAt,
      },
    })

    const response = await POST(request({
      phone: '+79222155750',
      channel: 'whatsapp',
      identityId: 'identity-1',
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'confirmed',
      reachable: true,
      cached: true,
      decisionSource: 'persisted',
      connectionHealth: 'connected',
      identityResolution: 'matched',
    })
    expect(whatsappMock.checkReachability).not.toHaveBeenCalled()
    expect(serviceMock.updateReachability).not.toHaveBeenCalled()
  })

  test('parallel stale opens coalesce to one provider request', async () => {
    serviceMock.resolveReachabilityIdentity.mockResolvedValue({
      kind: 'matched',
      identity: {
        id: 'identity-1',
        reachabilityStatus: 'unknown',
        reachabilityCheckedAt: null,
      },
    })
    let resolveProvider!: (value: unknown) => void
    whatsappMock.checkReachability.mockImplementation(() => new Promise(resolve => {
      resolveProvider = resolve
    }))

    const first = POST(request({ phone: '+79222155750', channel: 'whatsapp' }))
    const second = POST(request({ phone: '+79222155750', channel: 'whatsapp' }))
    await vi.waitFor(() => expect(whatsappMock.checkReachability).toHaveBeenCalledTimes(1))
    resolveProvider({ confirmed: true, reachable: true })

    const [firstBody, secondBody] = await Promise.all([
      first.then(response => response.json()),
      second.then(response => response.json()),
    ])
    expect([firstBody.decisionSource, secondBody.decisionSource].sort())
      .toEqual(['coalesced', 'live'])
    expect(firstBody.status).toBe('confirmed')
    expect(secondBody.status).toBe('confirmed')
    expect(whatsappMock.checkReachability).toHaveBeenCalledTimes(1)
  })

  test('client_not_ready is no connection, not an account-not-found answer', async () => {
    serviceMock.resolveReachabilityIdentity.mockResolvedValue({ kind: 'not_found' })
    whatsappMock.checkReachability.mockResolvedValue({
      confirmed: false,
      reachable: null,
      retryable: true,
      reason: 'client_not_ready',
      error: 'WhatsApp подключение восстанавливается',
    })

    const response = await POST(request({
      phone: '+79222155750',
      channel: 'whatsapp',
    }))
    expect(await response.json()).toMatchObject({
      status: 'checking',
      reachable: null,
      connectionHealth: 'disconnected',
      operationalFailure: true,
      errorCode: 'client_not_ready',
    })
    expect(serviceMock.updateReachability).not.toHaveBeenCalled()
  })

  test('an ambiguous identity resolution never persists a definitive result', async () => {
    serviceMock.resolveReachabilityIdentity.mockResolvedValue({
      kind: 'ambiguous',
      identityIds: ['identity-a', 'identity-b'],
    })
    whatsappMock.checkReachability.mockResolvedValue({
      confirmed: true,
      reachable: true,
    })

    const response = await POST(request({
      phone: '+79222155750',
      channel: 'whatsapp',
    }))
    expect(await response.json()).toMatchObject({
      status: 'confirmed',
      identityResolution: 'ambiguous',
    })
    expect(serviceMock.updateReachability).not.toHaveBeenCalled()
  })
})

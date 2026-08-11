import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkAllClientsHealth: vi.fn(),
  checkReachability: vi.fn(),
  cleanupStaleWhatsAppSessions: vi.fn(),
  destroyAllClients: vi.fn(),
  forceSync: vi.fn(),
  getClient: vi.fn(),
  getRuntimeStatus: vi.fn(),
  importWhatsAppHistory: vi.fn(),
  initializeClient: vi.fn(),
}))

vi.mock('@/lib/whatsapp/WhatsAppCleanup', () => ({
  cleanupStaleWhatsAppSessions: mocks.cleanupStaleWhatsAppSessions,
}))
vi.mock('@/lib/whatsapp/WhatsAppService', () => ({
  checkAllClientsHealth: mocks.checkAllClientsHealth,
  checkReachability: mocks.checkReachability,
  destroyAllClients: mocks.destroyAllClients,
  forceSync: mocks.forceSync,
  getClient: mocks.getClient,
  getRuntimeStatus: mocks.getRuntimeStatus,
  importWhatsAppHistory: mocks.importWhatsAppHistory,
  initializeClient: mocks.initializeClient,
}))

import {
  checkWhatsAppReachabilityV1,
  checkWhatsAppRuntimeHealthV1,
  cleanupStaleWhatsAppRuntimeV1,
  destroyWhatsAppRuntimeV1,
  forceSyncWhatsAppRuntimeV1,
  importWhatsAppHistoryV1,
  initializeWhatsAppRuntimeV1,
  inspectWhatsAppStoreV1,
  readWhatsAppRuntimeConnectionV1,
} from './runtime-operations'

beforeEach(() => vi.clearAllMocks())

describe('WhatsApp owner runtime operations', () => {
  it('delegates only fixed lifecycle, reachability and history operations', async () => {
    await cleanupStaleWhatsAppRuntimeV1()
    await initializeWhatsAppRuntimeV1('wa-1')
    await checkWhatsAppRuntimeHealthV1()
    await forceSyncWhatsAppRuntimeV1('wa-1')
    await checkWhatsAppReachabilityV1('+70000000001', 'wa-1')
    await importWhatsAppHistoryV1('job-1', 'last_n_days', 7, 'wa-1')
    await destroyWhatsAppRuntimeV1()

    expect(mocks.cleanupStaleWhatsAppSessions).toHaveBeenCalledWith()
    expect(mocks.initializeClient).toHaveBeenCalledWith('wa-1')
    expect(mocks.checkAllClientsHealth).toHaveBeenCalledWith()
    expect(mocks.forceSync).toHaveBeenCalledWith('wa-1')
    expect(mocks.checkReachability).toHaveBeenCalledWith('+70000000001', 'wa-1')
    expect(mocks.importWhatsAppHistory).toHaveBeenCalledWith('job-1', 'last_n_days', 7, 'wa-1')
    expect(mocks.destroyAllClients).toHaveBeenCalledWith()
  })

  it('returns a fixed runtime projection instead of the provider client', () => {
    const client = { user: { id: 'provider-user-1' }, secretTransport: true }
    mocks.getClient.mockReturnValue(client)
    expect(readWhatsAppRuntimeConnectionV1('wa-1')).toEqual({
      present: true,
      providerUserId: 'provider-user-1',
    })
    expect(readWhatsAppRuntimeConnectionV1('wa-1')).not.toBe(client)
  })

  it('keeps Puppeteer evaluation owner-local and returns only diagnostic JSON', async () => {
    const evaluate = vi.fn()
      .mockResolvedValueOnce({ hasMsg: true, hasChat: true })
      .mockResolvedValueOnce([{ id: 'chat-1', msgCount: 2 }])
    const providerClient = { pupPage: { evaluate }, opaqueProviderState: true }
    mocks.getClient.mockReturnValue(providerClient)

    const result = await inspectWhatsAppStoreV1('wa-1')

    expect(result).toEqual({
      storeInfo: { hasMsg: true, hasChat: true },
      sampleChats: [{ id: 'chat-1', msgCount: 2 }],
    })
    expect(JSON.stringify(result)).not.toContain('opaqueProviderState')
    expect(evaluate).toHaveBeenCalledTimes(2)
  })
})

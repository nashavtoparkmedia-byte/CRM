import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkTelegramReachability: vi.fn(),
  getTelegramConnections: vi.fn(),
  importTelegramHistory: vi.fn(),
  initTelegramListeners: vi.fn(),
  sendTelegramMessage: vi.fn(),
  stopTelegramHealthCheck: vi.fn(),
}))

vi.mock('@/app/tg-actions', () => mocks)

import {
  checkTelegramReachabilityV1,
  importTelegramHistoryV1,
  initializeTelegramRuntimeV1,
  listTelegramConnectionsV1,
  sendTelegramTextV1,
  stopTelegramRuntimeV1,
} from './runtime-operations'

beforeEach(() => vi.clearAllMocks())

describe('Telegram owner runtime operations', () => {
  it('delegates only fixed lifecycle, text, reachability and history operations', async () => {
    mocks.sendTelegramMessage.mockResolvedValue({ success: true })
    mocks.checkTelegramReachability.mockResolvedValue({ reachable: true, telegramId: 'tg-1' })

    await initializeTelegramRuntimeV1()
    await sendTelegramTextV1('+70000000001', 'hello', 'tg-connection-1')
    await importTelegramHistoryV1('job-1', 'last_n_days', 7, 'tg-connection-1')
    await checkTelegramReachabilityV1('+70000000001', 'tg-connection-1')
    await stopTelegramRuntimeV1()

    expect(mocks.initTelegramListeners).toHaveBeenCalledWith()
    expect(mocks.sendTelegramMessage).toHaveBeenCalledWith('+70000000001', 'hello', 'tg-connection-1')
    expect(mocks.importTelegramHistory).toHaveBeenCalledWith('job-1', 'last_n_days', 7, 'tg-connection-1')
    expect(mocks.checkTelegramReachability).toHaveBeenCalledWith('+70000000001', 'tg-connection-1')
    expect(mocks.stopTelegramHealthCheck).toHaveBeenCalledWith()
  })

  it('returns only the existing credential-safe connection projection', async () => {
    const projection = [{
      id: 'tg-connection-1',
      apiId: 123,
      isActive: true,
      isPaused: false,
      phoneNumber: '+70000000001',
      createdAt: new Date('2026-08-11T00:00:00Z'),
      updatedAt: new Date('2026-08-11T00:00:00Z'),
      isDefault: true,
      name: 'Default',
      apiHashConfigured: true,
      sessionConfigured: true,
    }]
    mocks.getTelegramConnections.mockResolvedValue(projection)

    await expect(listTelegramConnectionsV1()).resolves.toBe(projection)
    expect(JSON.stringify(await listTelegramConnectionsV1())).not.toMatch(/apiHash['\"]|sessionString/)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getMaxConnections: vi.fn(),
  sendMaxMessage: vi.fn(),
}))
vi.mock('@/app/max-actions', () => mocks)

import {
  listMaxDriverDeliveryConnectionsV1,
  sendMaxDriverMessageV1,
} from './driver-max-messaging'

beforeEach(() => vi.clearAllMocks())

describe('driver MAX messaging composition', () => {
  it('preserves the authorized metadata query', async () => {
    mocks.getMaxConnections.mockResolvedValue([{ id: 'max-1', name: 'Default' }])
    await expect(listMaxDriverDeliveryConnectionsV1()).resolves.toEqual([{ id: 'max-1', name: 'Default' }])
    expect(mocks.getMaxConnections).toHaveBeenCalledOnce()
  })

  it('delegates only the manager-to-driver message shape', async () => {
    mocks.sendMaxMessage.mockResolvedValue({ success: true })
    const options = { connectionId: 'max-1', isPersonal: true, name: 'Driver One' }
    await sendMaxDriverMessageV1('+79990000000', 'hello', options)
    expect(mocks.sendMaxMessage).toHaveBeenCalledWith('+79990000000', 'hello', options)
  })
})

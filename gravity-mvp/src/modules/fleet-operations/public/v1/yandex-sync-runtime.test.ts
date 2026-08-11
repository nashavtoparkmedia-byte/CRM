import { beforeEach, describe, expect, it, vi } from 'vitest'

const runYandexSync = vi.hoisted(() => vi.fn())
vi.mock('@/lib/yandexSync', () => ({ runYandexSync }))

import { runScheduledYandexSyncV1 } from './yandex-sync-runtime'

beforeEach(() => vi.clearAllMocks())

describe('scheduled Yandex sync capability', () => {
  it('exposes only the fixed cooldown-bypassing scheduled operation', async () => {
    runYandexSync.mockResolvedValue({ ok: true, driversUpdated: 3 })
    await expect(runScheduledYandexSyncV1()).resolves.toEqual({ ok: true, driversUpdated: 3 })
    expect(runYandexSync).toHaveBeenCalledWith({ bypassCooldown: true })
  })
})

import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  findStatus: vi.fn(),
  updateStatus: vi.fn(),
  getThresholds: vi.fn(),
  reconcile: vi.fn(),
  syncTrips: vi.fn(),
  recalculate: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: mocks.acquire,
    syncStatus: {
      findUnique: mocks.findStatus,
      updateMany: mocks.updateStatus,
    },
  },
}))
vi.mock('@/lib/YandexFleetService', () => ({
  YandexFleetService: { syncTrips: mocks.syncTrips },
}))
vi.mock('@/lib/scoring', () => ({
  getThresholds: mocks.getThresholds,
  recalculateAllSegments: mocks.recalculate,
}))
vi.mock('@/modules/fleet-operations/public/v1', () => ({
  RECONCILE_YANDEX_FLEET_COMMAND_V1: 'fleet_operations.ReconcileYandexFleetCommand.v1',
  reconcileYandexFleetV1: mocks.reconcile,
}))

import {
  runYandexSync,
  YANDEX_SYNC_LEASE_HEARTBEAT_MS,
  YANDEX_SYNC_RUNNING_STALE_MS,
} from '../yandexSync'

describe('Yandex sync fenced lease', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateStatus.mockResolvedValue({ count: 1 })
    mocks.getThresholds.mockResolvedValue({ analysis_period: 45 })
    mocks.reconcile.mockResolvedValue({ profilesUpserted: 2 })
    mocks.syncTrips.mockResolvedValue({ ordersProcessed: 3 })
    mocks.recalculate.mockResolvedValue({ count: 4 })
  })

  test('simultaneous starts cannot both acquire the atomic lease', async () => {
    let releaseThresholds!: (value: { analysis_period: number }) => void
    const thresholds = new Promise<{ analysis_period: number }>(resolve => { releaseThresholds = resolve })
    mocks.acquire.mockResolvedValueOnce([{ service: 'yandex_fleet' }]).mockResolvedValueOnce([])
    mocks.getThresholds.mockReturnValueOnce(thresholds)
    mocks.findStatus.mockResolvedValueOnce({
      service: 'yandex_fleet', lastRunAt: new Date(), status: 'running',
      errorMessage: 'lease:other', driversUpdated: null, ordersProcessed: null, updatedAt: new Date(),
    })

    const first = runYandexSync({ bypassCooldown: true })
    await vi.waitFor(() => expect(mocks.getThresholds).toHaveBeenCalledTimes(1))
    await expect(runYandexSync({ bypassCooldown: true })).resolves.toEqual({
      ok: false, reason: 'already_running',
    })
    releaseThresholds({ analysis_period: 45 })
    await expect(first).resolves.toMatchObject({ ok: true, driversUpdated: 2, ordersProcessed: 3 })
    expect(mocks.acquire).toHaveBeenCalledTimes(2)
  })

  test('a superseded run cannot publish a late terminal status', async () => {
    mocks.acquire.mockResolvedValueOnce([{ service: 'yandex_fleet' }])
    mocks.updateStatus
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })

    await expect(runYandexSync({ bypassCooldown: true })).resolves.toEqual({
      ok: false, reason: 'lease_lost',
    })
    expect(mocks.updateStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'running', errorMessage: expect.stringMatching(/^lease:/) }),
      data: expect.objectContaining({ status: 'success' }),
    }))
  })

  test('a healthy long-running phase renews below expiry and cannot be superseded', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-02T00:00:00.000Z'))
      let lastRenewedAt = Date.now()
      let acquireCount = 0
      mocks.acquire.mockImplementation(async () => {
        acquireCount += 1
        if (acquireCount === 1 || Date.now() - lastRenewedAt > YANDEX_SYNC_RUNNING_STALE_MS) {
          lastRenewedAt = Date.now()
          return [{ service: 'yandex_fleet' }]
        }
        return []
      })
      mocks.updateStatus.mockImplementation(async (input: { data: { lastRunAt?: Date } }) => {
        if (input.data.lastRunAt) lastRenewedAt = input.data.lastRunAt.getTime()
        return { count: 1 }
      })
      mocks.findStatus.mockImplementation(async () => ({
        service: 'yandex_fleet', lastRunAt: new Date(lastRenewedAt), status: 'running',
        errorMessage: 'lease:holder', driversUpdated: null, ordersProcessed: null,
        updatedAt: new Date(lastRenewedAt),
      }))
      let releaseReconciliation!: (value: { profilesUpserted: number }) => void
      mocks.reconcile.mockReturnValueOnce(new Promise(resolve => { releaseReconciliation = resolve }))

      const holder = runYandexSync({ bypassCooldown: true })
      await vi.waitFor(() => expect(mocks.reconcile).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(YANDEX_SYNC_RUNNING_STALE_MS + YANDEX_SYNC_LEASE_HEARTBEAT_MS)

      await expect(runYandexSync({ bypassCooldown: true })).resolves.toEqual({
        ok: false, reason: 'already_running',
      })
      expect(Date.now() - lastRenewedAt).toBeLessThan(YANDEX_SYNC_RUNNING_STALE_MS)

      releaseReconciliation({ profilesUpserted: 2 })
      await expect(holder).resolves.toMatchObject({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })

  test('a crashed stale holder can be replaced', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'))
      const staleLastRunAt = Date.now() - YANDEX_SYNC_RUNNING_STALE_MS - 1
      mocks.acquire.mockImplementationOnce(async () => (
        Date.now() - staleLastRunAt > YANDEX_SYNC_RUNNING_STALE_MS
          ? [{ service: 'yandex_fleet' }]
          : []
      ))

      await expect(runYandexSync({ bypassCooldown: true })).resolves.toMatchObject({
        ok: true,
        driversUpdated: 2,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

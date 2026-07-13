import { describe, expect, test } from 'vitest'
import { buildNightlyDriverProfileSchedule, InMemoryNightlySyncLock, runNightlyDriverProfileSync, type NightlyParkConnection } from '../driver-profiles/nightly-sync'

const connections: NightlyParkConnection[] = [
  { apiConnectionId: 'c1', parkCode: 'NASH_AVTOPARK', parkName: 'Наш Автопарк', externalParkId: 'p1', enabled: true },
  { apiConnectionId: 'c2', parkCode: 'YOKO', parkName: 'YOKO', externalParkId: 'p2', enabled: true },
  { apiConnectionId: 'c3', parkCode: 'YOKO_2', parkName: 'YOKO-2', externalParkId: 'p3', enabled: true },
]
const success = { profilesProcessed: 10, sourceRows: 10, dedupedRows: 10, inserts: 0, updates: 0, unchanged: 10, retries: 0, errors: 0 }

describe('nightly multi-park DriverProfile sync primitives', () => {
  test('schedule is fixed at 03:00 Asia/Yekaterinburg and auto-registered in production', () => {
    expect(buildNightlyDriverProfileSchedule()).toMatchObject({
      jobId: 'multi-park-driver-profiles-nightly',
      cron: '0 3 * * *',
      hour: 3,
      minute: 0,
      timezone: 'Asia/Yekaterinburg',
      productionAutoRegistered: true,
    })
  })

  test('runs every enabled park and keeps partial failure isolated', async () => {
    const result = await runNightlyDriverProfileSync({
      connections,
      lock: new InMemoryNightlySyncLock(),
      maxAttempts: 1,
      syncPark: async connection => {
        if (connection.parkCode === 'YOKO') {
          throw Object.assign(new Error('429 retry exhausted'), { nightlyStats: { sourceRows: 7, retries: 4, errors: 1 } })
        }
        return success
      },
    })
    expect(result.status).toBe('partial_failure')
    expect(result.results.map(item => item.parkCode)).toEqual(['NASH_AVTOPARK', 'YOKO', 'YOKO_2'])
    expect(result.results.find(item => item.parkCode === 'YOKO')?.status).toBe('failed')
    expect(result.results.find(item => item.parkCode === 'YOKO')).toMatchObject({ sourceRows: 7, retries: 4, errors: 1 })
  })

  test('parallel manual and scheduled runs are rejected by the shared lock', async () => {
    const lock = new InMemoryNightlySyncLock()
    await lock.acquire('driver-profiles:nightly-full-sync')
    const result = await runNightlyDriverProfileSync({ connections, lock, syncPark: async () => success })
    expect(result.status).toBe('skipped_locked')
    expect(result.lockAcquired).toBe(false)
  })

  test('lock is released after a failed run and a later run can proceed', async () => {
    const lock = new InMemoryNightlySyncLock()
    const first = await runNightlyDriverProfileSync({ connections, lock, maxAttempts: 1, syncPark: async () => { throw new Error('source unavailable') } })
    const second = await runNightlyDriverProfileSync({ connections, lock, syncPark: async () => success })
    expect(first.status).toBe('failed')
    expect(second.status).toBe('success')
    expect(second.results).toHaveLength(3)
  })
})

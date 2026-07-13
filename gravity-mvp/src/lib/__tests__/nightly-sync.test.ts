import { describe, expect, test } from 'vitest'
import { buildNightlyDriverProfileSchedule, InMemoryNightlySyncLock, runNightlyDriverProfileSync, type NightlyParkConnection } from '../driver-profiles/nightly-sync'

const connections: NightlyParkConnection[] = [
  { apiConnectionId: 'c1', parkCode: 'NASH_AVTOPARK', parkName: 'Наш Автопарк', enabled: true },
  { apiConnectionId: 'c2', parkCode: 'YOKO', parkName: 'YOKO', enabled: true },
  { apiConnectionId: 'c3', parkCode: 'YOKO_2', parkName: 'YOKO-2', enabled: true },
]

describe('nightly multi-park DriverProfile sync primitives', () => {
  test('schedule is fixed at 03:00 Asia/Yekaterinburg and not auto-registered in production', () => {
    expect(buildNightlyDriverProfileSchedule()).toMatchObject({ hour: 3, minute: 0, timezone: 'Asia/Yekaterinburg', productionAutoRegistered: false })
  })

  test('runs every enabled park and keeps partial failure isolated', async () => {
    const result = await runNightlyDriverProfileSync({
      connections,
      lock: new InMemoryNightlySyncLock(),
      maxAttempts: 1,
      syncPark: async connection => {
        if (connection.parkCode === 'YOKO') throw new Error('429 retry exhausted')
        return { profilesProcessed: 10 }
      },
    })
    expect(result.status).toBe('partial_failure')
    expect(result.results.map(item => item.parkCode)).toEqual(['NASH_AVTOPARK', 'YOKO', 'YOKO_2'])
    expect(result.results.find(item => item.parkCode === 'YOKO')?.status).toBe('failed')
  })

  test('parallel run is rejected by lock', async () => {
    const lock = new InMemoryNightlySyncLock()
    await lock.acquire('driver-profiles:nightly-full-sync')
    const result = await runNightlyDriverProfileSync({ connections, lock, syncPark: async () => ({ profilesProcessed: 1 }) })
    expect(result.status).toBe('skipped_locked')
    expect(result.lockAcquired).toBe(false)
  })

  test('repeated run is idempotent for the scheduler contract', async () => {
    const lock = new InMemoryNightlySyncLock()
    const syncPark = async () => ({ profilesProcessed: 1 })
    const first = await runNightlyDriverProfileSync({ connections, lock, syncPark })
    const second = await runNightlyDriverProfileSync({ connections, lock, syncPark })
    expect(first.status).toBe('success')
    expect(second.status).toBe('success')
    expect(second.results).toHaveLength(3)
  })
})

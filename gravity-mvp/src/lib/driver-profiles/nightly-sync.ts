import { APPROVED_PARKS, type ParkCode } from './park-identity'
import { retryDelayMs } from './park-inventory'

export const NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE = 'Asia/Yekaterinburg'
export const NIGHTLY_DRIVER_PROFILE_SYNC_HOUR = 3

export type NightlyParkConnection = {
  apiConnectionId: string
  parkCode: ParkCode
  parkName: string
  enabled: boolean
}

export type NightlyParkResult = {
  parkCode: ParkCode
  status: 'success' | 'failed'
  profilesProcessed: number
  durationMs: number
  attempts: number
  error?: string
}

export type NightlySyncRunResult = {
  startedAt: string
  finishedAt: string
  timezone: typeof NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE
  lockAcquired: boolean
  status: 'success' | 'partial_failure' | 'failed' | 'skipped_locked'
  results: NightlyParkResult[]
}

export type NightlySyncLock = {
  acquire(key: string): Promise<boolean>
  release(key: string): Promise<void>
}

export class InMemoryNightlySyncLock implements NightlySyncLock {
  private locked = new Set<string>()

  async acquire(key: string) {
    if (this.locked.has(key)) return false
    this.locked.add(key)
    return true
  }

  async release(key: string) {
    this.locked.delete(key)
  }
}

export function buildNightlyDriverProfileSchedule() {
  return {
    hour: NIGHTLY_DRIVER_PROFILE_SYNC_HOUR,
    minute: 0,
    timezone: NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE,
    parks: APPROVED_PARKS.map(park => park.parkCode),
    productionAutoRegistered: false,
  }
}

export async function runNightlyDriverProfileSync(input: {
  connections: NightlyParkConnection[]
  lock: NightlySyncLock
  syncPark: (connection: NightlyParkConnection) => Promise<{ profilesProcessed: number }>
  now?: () => Date
  maxAttempts?: number
}) : Promise<NightlySyncRunResult> {
  const started = input.now?.() || new Date()
  const lockKey = 'driver-profiles:nightly-full-sync'
  const acquired = await input.lock.acquire(lockKey)
  if (!acquired) {
    const finished = input.now?.() || new Date()
    return { startedAt: started.toISOString(), finishedAt: finished.toISOString(), timezone: NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE, lockAcquired: false, status: 'skipped_locked', results: [] }
  }

  const results: NightlyParkResult[] = []
  try {
    for (const connection of input.connections.filter(item => item.enabled)) {
      const parkStart = Date.now()
      let attempts = 0
      let lastError = ''
      const maxAttempts = input.maxAttempts ?? 3
      while (attempts < maxAttempts) {
        attempts += 1
        try {
          const result = await input.syncPark(connection)
          results.push({ parkCode: connection.parkCode, status: 'success', profilesProcessed: result.profilesProcessed, durationMs: Date.now() - parkStart, attempts })
          lastError = ''
          break
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
          if (attempts < maxAttempts) retryDelayMs(attempts, null, () => 0)
        }
      }
      if (lastError) {
        results.push({ parkCode: connection.parkCode, status: 'failed', profilesProcessed: 0, durationMs: Date.now() - parkStart, attempts, error: lastError })
      }
    }
  } finally {
    await input.lock.release(lockKey)
  }

  const failed = results.filter(result => result.status === 'failed').length
  const status = failed === 0 ? 'success' : failed === results.length ? 'failed' : 'partial_failure'
  const finished = input.now?.() || new Date()
  return { startedAt: started.toISOString(), finishedAt: finished.toISOString(), timezone: NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE, lockAcquired: true, status, results }
}

import { APPROVED_PARKS, type ParkCode } from './park-identity'
import { retryDelayMs } from './park-inventory'

export const NIGHTLY_DRIVER_PROFILE_SYNC_JOB_ID = 'multi-park-driver-profiles-nightly'
export const NIGHTLY_DRIVER_PROFILE_SYNC_CRON = '0 3 * * *'
export const NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE = 'Asia/Yekaterinburg'
export const NIGHTLY_DRIVER_PROFILE_SYNC_HOUR = 3
export const NIGHTLY_DRIVER_PROFILE_SYNC_LOCK_KEY = 'driver-profiles:nightly-full-sync'

export type NightlyParkConnection = {
  apiConnectionId: string
  parkCode: ParkCode
  parkName: string
  enabled: boolean
  externalParkId: string
}

export type NightlyParkResult = {
  parkCode: ParkCode
  status: 'success' | 'failed'
  profilesProcessed: number
  durationMs: number
  externalParkId: string
  sourceRows: number
  dedupedRows: number
  inserts: number
  updates: number
  unchanged: number
  retries: number
  errors: number
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
  release(key: string, outcome?: { status: 'success' | 'error'; error?: string }): Promise<void>
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
    jobId: NIGHTLY_DRIVER_PROFILE_SYNC_JOB_ID,
    cron: NIGHTLY_DRIVER_PROFILE_SYNC_CRON,
    hour: NIGHTLY_DRIVER_PROFILE_SYNC_HOUR,
    minute: 0,
    timezone: NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE,
    parks: APPROVED_PARKS.map(park => park.parkCode),
    productionAutoRegistered: true,
  }
}

export async function runNightlyDriverProfileSync(input: {
  connections: NightlyParkConnection[]
  lock: NightlySyncLock
  syncPark: (connection: NightlyParkConnection) => Promise<Omit<NightlyParkResult, 'parkCode' | 'externalParkId' | 'status' | 'durationMs' | 'attempts' | 'error'>>
  now?: () => Date
  maxAttempts?: number
  sleep?: (ms: number) => Promise<void>
}) : Promise<NightlySyncRunResult> {
  const started = input.now?.() || new Date()
  const lockKey = NIGHTLY_DRIVER_PROFILE_SYNC_LOCK_KEY
  const acquired = await input.lock.acquire(lockKey)
  if (!acquired) {
    const finished = input.now?.() || new Date()
    return { startedAt: started.toISOString(), finishedAt: finished.toISOString(), timezone: NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE, lockAcquired: false, status: 'skipped_locked', results: [] }
  }

  const results: NightlyParkResult[] = []
  try {
    for (const connection of input.connections.filter(item => item.enabled)) {
      const parkStart = Date.now()
      const emptyStats = { profilesProcessed: 0, sourceRows: 0, dedupedRows: 0, inserts: 0, updates: 0, unchanged: 0, retries: 0, errors: 1 }
      let attempts = 0
      let lastError = ''
      let lastFailureStats: Partial<typeof emptyStats> = {}
      const maxAttempts = input.maxAttempts ?? 3
      while (attempts < maxAttempts) {
        attempts += 1
        try {
          const result = await input.syncPark(connection)
          results.push({
            parkCode: connection.parkCode,
            externalParkId: connection.externalParkId,
            status: 'success',
            durationMs: Date.now() - parkStart,
            attempts,
            ...result,
          })
          lastError = ''
          break
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
          if (err && typeof err === 'object' && 'nightlyStats' in err) {
            lastFailureStats = (err as { nightlyStats?: Partial<typeof emptyStats> }).nightlyStats || {}
          }
          if (attempts < maxAttempts) {
            const delayMs = retryDelayMs(attempts, null)
            await (input.sleep || ((ms: number) => new Promise(resolve => setTimeout(resolve, ms))))(delayMs)
          }
        }
      }
      if (lastError) {
        results.push({
          parkCode: connection.parkCode,
          externalParkId: connection.externalParkId,
          status: 'failed',
          durationMs: Date.now() - parkStart,
          attempts,
          error: lastError,
          ...emptyStats,
          ...lastFailureStats,
          errors: 1,
        })
      }
    }
  } finally {
    const failed = results.filter(result => result.status === 'failed')
    await input.lock.release(lockKey, {
      status: failed.length > 0 ? 'error' : 'success',
      ...(failed.length > 0 ? { error: failed.map(result => `${result.parkCode}: ${result.error}`).join('; ') } : {}),
    })
  }

  const failed = results.filter(result => result.status === 'failed').length
  const status = failed === 0 ? 'success' : failed === results.length ? 'failed' : 'partial_failure'
  const finished = input.now?.() || new Date()
  return { startedAt: started.toISOString(), finishedAt: finished.toISOString(), timezone: NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE, lockAcquired: true, status, results }
}

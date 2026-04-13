import { opsLog } from '@/lib/opsLog'
import { logCronHealth } from '@/lib/cron-health'

/**
 * OperationalJobs — tracks periodic background job state with overlap guard.
 *
 * Each job has:
 *   - isRunning: prevents overlapping executions
 *   - lastRunAt / lastCompletedAt / lastResult / lastError: for health reporting
 *
 * Usage:
 *   const handle = await OperationalJobs.run('recovery', async () => { ... return result })
 */

interface JobState {
  isRunning: boolean
  lastRunAt: Date | null
  lastCompletedAt: Date | null
  lastResult: unknown
  lastError: string | null
}

const jobs = new Map<string, JobState>()
const intervals: NodeJS.Timeout[] = []

function getOrCreate(name: string): JobState {
  if (!jobs.has(name)) {
    jobs.set(name, {
      isRunning: false,
      lastRunAt: null,
      lastCompletedAt: null,
      lastResult: null,
      lastError: null,
    })
  }
  return jobs.get(name)!
}

export class OperationalJobs {

  /**
   * Run a job with overlap guard. If the job is already running, skip.
   * Returns the result or null if skipped.
   */
  static async run<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    const state = getOrCreate(name)

    if (state.isRunning) {
      opsLog('info', 'job_skipped_overlap', { operation: name })
      logCronHealth({ cronName: name, status: 'skipped', durationMs: 0 }).catch(() => {})
      return null
    }

    state.isRunning = true
    state.lastRunAt = new Date()
    state.lastError = null
    const start = Date.now()

    try {
      const result = await fn()
      state.lastResult = result
      state.lastCompletedAt = new Date()
      const durationMs = Date.now() - start
      logCronHealth({ cronName: name, status: 'ok', durationMs }).catch(() => {})
      return result
    } catch (err: any) {
      state.lastError = err.message || String(err)
      const durationMs = Date.now() - start
      opsLog('error', 'job_failed', { operation: name, error: state.lastError || undefined })
      logCronHealth({ cronName: name, status: 'error', durationMs, errorMessage: state.lastError }).catch(() => {})
      return null
    } finally {
      state.isRunning = false
    }
  }

  /**
   * Register a periodic interval. Tracked for graceful shutdown cleanup.
   */
  static registerInterval(interval: NodeJS.Timeout): void {
    intervals.push(interval)
  }

  /**
   * Clear all registered intervals. Called during graceful shutdown.
   */
  static clearAllIntervals(): void {
    for (const interval of intervals) {
      clearInterval(interval)
    }
    intervals.length = 0
  }

  /**
   * Get state of a specific job (for health endpoint).
   */
  static getJobState(name: string): JobState | null {
    return jobs.get(name) ?? null
  }

  /**
   * Get all job states (for health endpoint).
   */
  static getAllJobStates(): Record<string, JobState> {
    const result: Record<string, JobState> = {}
    for (const [name, state] of jobs) {
      result[name] = { ...state }
    }
    return result
  }
}

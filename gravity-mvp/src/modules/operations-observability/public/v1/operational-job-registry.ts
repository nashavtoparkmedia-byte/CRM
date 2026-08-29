import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { logCronHealth } from '@/lib/cron-health'

export interface OperationalJobStateV1 {
  isRunning: boolean
  lastRunAt: Date | null
  lastCompletedAt: Date | null
  lastResult: unknown
  lastError: string | null
}

const jobs = new Map<string, OperationalJobStateV1>()
const intervals: NodeJS.Timeout[] = []

function getOrCreate(name: string): OperationalJobStateV1 {
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

export async function runOperationalJobV1<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
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

export function registerOperationalIntervalV1(interval: NodeJS.Timeout): void {
  intervals.push(interval)
}

export function clearOperationalIntervalsV1(): void {
  for (const interval of intervals) {
    clearInterval(interval)
  }
  intervals.length = 0
}

export function getOperationalJobStateV1(name: string): OperationalJobStateV1 | null {
  return jobs.get(name) ?? null
}

export function listOperationalJobStatesV1(): Record<string, OperationalJobStateV1> {
  const result: Record<string, OperationalJobStateV1> = {}
  for (const [name, state] of jobs) {
    result[name] = { ...state }
  }
  return result
}

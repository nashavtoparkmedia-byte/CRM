import { logCronHealth } from '@/lib/cron-health'
import { opsLog } from '@/lib/opsLog'
import {
  NIGHTLY_DRIVER_PROFILE_SYNC_CRON,
  NIGHTLY_DRIVER_PROFILE_SYNC_JOB_ID,
  NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE,
} from './nightly-sync'
import { runProductionDriverProfileSync } from './production-sync'

type SchedulerStatus = 'pending' | 'registered' | 'failed' | 'disabled' | 'stopped'

type SchedulerState = {
  status: SchedulerStatus
  timer: ReturnType<typeof setTimeout> | null
  registrationCount: number
  nextRunUtc: string | null
  nextRunLocal: string | null
  lastError: string | null
}

export type SchedulerRegistration = Omit<SchedulerState, 'timer'> & {
  jobId: typeof NIGHTLY_DRIVER_PROFILE_SYNC_JOB_ID
  cron: typeof NIGHTLY_DRIVER_PROFILE_SYNC_CRON
  timezone: typeof NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE
  productionAutoRegistered: true
}

type SchedulerDependencies = {
  enabled?: boolean
  now?: () => Date
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  runSync?: typeof runProductionDriverProfileSync
}

const GLOBAL_STATE_KEY = '__crmMultiParkProductionSchedulerState__'
const globalScheduler = globalThis as typeof globalThis & { [GLOBAL_STATE_KEY]?: SchedulerState }

function getState(): SchedulerState {
  if (!globalScheduler[GLOBAL_STATE_KEY]) {
    globalScheduler[GLOBAL_STATE_KEY] = {
      status: 'pending',
      timer: null,
      registrationCount: 0,
      nextRunUtc: null,
      nextRunLocal: null,
      lastError: null,
    }
  }
  return globalScheduler[GLOBAL_STATE_KEY]
}

function zonedParts(date: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  }
}

export function formatSchedulerLocalTime(date: Date): string {
  const parts = zonedParts(date)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)} ${NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE}`
}

export function getNextNightlyDriverProfileRun(from: Date): Date {
  const firstMinute = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000)
  for (let minute = 0; minute < 3 * 24 * 60; minute += 1) {
    const candidate = new Date(firstMinute.getTime() + minute * 60_000)
    const parts = zonedParts(candidate)
    if (parts.hour === 3 && parts.minute === 0) return candidate
  }
  throw new Error(`could not resolve next ${NIGHTLY_DRIVER_PROFILE_SYNC_CRON} run in ${NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE}`)
}

function publicState(): SchedulerRegistration {
  const state = getState()
  return {
    status: state.status,
    registrationCount: state.registrationCount,
    nextRunUtc: state.nextRunUtc,
    nextRunLocal: state.nextRunLocal,
    lastError: state.lastError,
    jobId: NIGHTLY_DRIVER_PROFILE_SYNC_JOB_ID,
    cron: NIGHTLY_DRIVER_PROFILE_SYNC_CRON,
    timezone: NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE,
    productionAutoRegistered: true,
  }
}

export function getMultiParkSchedulerRegistration(): SchedulerRegistration {
  return publicState()
}

export function registerMultiParkProductionScheduler(dependencies: SchedulerDependencies = {}): SchedulerRegistration {
  const state = getState()
  const enabled = dependencies.enabled ?? process.env.NODE_ENV === 'production'
  if (!enabled) {
    state.status = 'disabled'
    state.lastError = null
    return publicState()
  }
  if (state.status === 'registered' && state.timer) return publicState()

  const now = dependencies.now || (() => new Date())
  const setTimer = dependencies.setTimer || setTimeout
  const runSync = dependencies.runSync || runProductionDriverProfileSync

  const scheduleNext = () => {
    const current = now()
    const nextRun = getNextNightlyDriverProfileRun(current)
    const delayMs = Math.max(1, nextRun.getTime() - current.getTime())
    state.nextRunUtc = nextRun.toISOString()
    state.nextRunLocal = formatSchedulerLocalTime(nextRun)
    state.timer = setTimer(() => {
      state.timer = null
      const started = Date.now()
      void runSync('scheduled')
        .then(result => {
          logCronHealth({
            cronName: NIGHTLY_DRIVER_PROFILE_SYNC_JOB_ID,
            status: result.status === 'success' ? 'ok' : result.status === 'skipped_locked' ? 'skipped' : 'error',
            durationMs: Date.now() - started,
            ...(result.status === 'partial_failure' || result.status === 'failed' ? { errorMessage: result.status } : {}),
            metadata: { parks: result.results.length, timezone: NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE },
          }).catch(() => undefined)
        })
        .catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          opsLog('error', 'multi_park_scheduler_run_failed', { operation: NIGHTLY_DRIVER_PROFILE_SYNC_JOB_ID, error: message })
          logCronHealth({ cronName: NIGHTLY_DRIVER_PROFILE_SYNC_JOB_ID, status: 'error', durationMs: Date.now() - started, errorMessage: message }).catch(() => undefined)
        })
        .finally(() => {
          if (state.status === 'registered') scheduleNext()
        })
    }, delayMs)
    state.timer.unref?.()
  }

  try {
    scheduleNext()
    state.status = 'registered'
    state.registrationCount += 1
    state.lastError = null
    opsLog('info', 'multi_park_scheduler_registered', {
      operation: NIGHTLY_DRIVER_PROFILE_SYNC_JOB_ID,
      cron: NIGHTLY_DRIVER_PROFILE_SYNC_CRON,
      timezone: NIGHTLY_DRIVER_PROFILE_SYNC_TIMEZONE,
      nextRunLocal: state.nextRunLocal || undefined,
      nextRunUtc: state.nextRunUtc || undefined,
      productionAutoRegistered: true,
    })
  } catch (error) {
    state.status = 'failed'
    state.lastError = error instanceof Error ? error.message : String(error)
    state.timer = null
    opsLog('error', 'multi_park_scheduler_registration_failed', { operation: NIGHTLY_DRIVER_PROFILE_SYNC_JOB_ID, error: state.lastError })
    throw error
  }
  return publicState()
}

export function stopMultiParkProductionScheduler(clearTimer: typeof clearTimeout = clearTimeout): void {
  const state = getState()
  if (state.timer) clearTimer(state.timer)
  state.timer = null
  state.status = 'stopped'
  state.nextRunLocal = null
  state.nextRunUtc = null
}

export function getMultiParkSchedulerHealthCheck(): { name: string; ok: boolean; ms: number; error?: string } {
  const state = getState()
  if (process.env.NODE_ENV !== 'production' && state.status === 'pending') {
    return { name: 'multi_park_scheduler', ok: true, ms: 0 }
  }
  if (state.status === 'registered' && state.timer) return { name: 'multi_park_scheduler', ok: true, ms: 0 }
  return { name: 'multi_park_scheduler', ok: false, ms: 0, error: state.lastError || `scheduler_${state.status}` }
}

export function resetMultiParkProductionSchedulerForTests(): void {
  const state = getState()
  if (state.timer) clearTimeout(state.timer)
  delete globalScheduler[GLOBAL_STATE_KEY]
}

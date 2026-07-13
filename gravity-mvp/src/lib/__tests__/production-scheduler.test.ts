import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  formatSchedulerLocalTime,
  getMultiParkSchedulerRegistration,
  getNextNightlyDriverProfileRun,
  registerMultiParkProductionScheduler,
  resetMultiParkProductionSchedulerForTests,
  stopMultiParkProductionScheduler,
} from '../driver-profiles/production-scheduler'

afterEach(() => resetMultiParkProductionSchedulerForTests())

function fakeTimers() {
  const active = new Set<object>()
  const callbacks: Array<() => void> = []
  const setTimer = ((callback: () => void) => {
    const handle = { unref: () => handle }
    active.add(handle)
    callbacks.push(callback)
    return handle
  }) as unknown as typeof setTimeout
  const clearTimer = ((handle: object) => active.delete(handle)) as unknown as typeof clearTimeout
  return { active, callbacks, setTimer, clearTimer }
}

describe('production multi-park scheduler registration', () => {
  test('calculates 03:00 Asia/Yekaterinburg independently of host timezone', () => {
    const next = getNextNightlyDriverProfileRun(new Date('2026-07-13T14:42:27.000Z'))
    expect(next.toISOString()).toBe('2026-07-13T22:00:00.000Z')
    expect(formatSchedulerLocalTime(next)).toBe('2026-07-14 03:00 Asia/Yekaterinburg')
  })

  test('startup registers one timer, is idempotent, and does not run sync immediately', () => {
    const timers = fakeTimers()
    const runSync = vi.fn()
    const now = () => new Date('2026-07-13T14:42:27.000Z')
    const first = registerMultiParkProductionScheduler({ enabled: true, now, setTimer: timers.setTimer, runSync })
    const second = registerMultiParkProductionScheduler({ enabled: true, now, setTimer: timers.setTimer, runSync })
    expect(first).toMatchObject({
      status: 'registered',
      productionAutoRegistered: true,
      jobId: 'multi-park-driver-profiles-nightly',
      cron: '0 3 * * *',
      timezone: 'Asia/Yekaterinburg',
      registrationCount: 1,
      nextRunUtc: '2026-07-13T22:00:00.000Z',
    })
    expect(second.registrationCount).toBe(1)
    expect(timers.active.size).toBe(1)
    expect(runSync).not.toHaveBeenCalled()
  })

  test('process restart registration restores exactly one timer', () => {
    const timers = fakeTimers()
    const now = () => new Date('2026-07-13T14:42:27.000Z')
    registerMultiParkProductionScheduler({ enabled: true, now, setTimer: timers.setTimer })
    stopMultiParkProductionScheduler(timers.clearTimer)
    expect(timers.active.size).toBe(0)
    registerMultiParkProductionScheduler({ enabled: true, now, setTimer: timers.setTimer })
    expect(timers.active.size).toBe(1)
    expect(getMultiParkSchedulerRegistration().registrationCount).toBe(2)
  })

  test('legacy hourly scheduler registration is absent from instrumentation', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/instrumentation.ts'), 'utf8')
    const legacyRoute = fs.readFileSync(path.join(process.cwd(), 'src/app/api/cron/sync-trips/route.ts'), 'utf8')
    expect(source).toContain('registerMultiParkProductionScheduler')
    expect(source).not.toContain('YANDEX_SYNC_HOUR')
    expect(source).not.toContain("OperationalJobs.run('yandex_fleet_sync'")
    expect(source).not.toContain("import('@/lib/yandexSync')")
    expect(legacyRoute).toContain('legacy_scheduler_disabled')
    expect(legacyRoute).not.toContain('runYandexSync')
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
  logCronHealth: vi.fn().mockResolvedValue(undefined),
  opsLog: vi.fn(),
}))

vi.mock('@/lib/cron-health', () => ({ logCronHealth: operations.logCronHealth }))
vi.mock('@/infrastructure/operations/operational-log', () => ({ operationalLogV1: operations.opsLog }))

import {
  clearOperationalIntervalsV1,
  getOperationalJobStateV1,
  listOperationalJobStatesV1,
  registerOperationalIntervalV1,
  runOperationalJobV1,
} from './operational-job-registry'

describe('Operations operational-job registry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records a successful result and reports it through both read models', async () => {
    await expect(runOperationalJobV1('test_success', async () => ({ count: 2 })))
      .resolves.toEqual({ count: 2 })

    const state = getOperationalJobStateV1('test_success')
    expect(state).toMatchObject({ isRunning: false, lastResult: { count: 2 }, lastError: null })
    expect(state?.lastRunAt).toBeInstanceOf(Date)
    expect(state?.lastCompletedAt).toBeInstanceOf(Date)
    expect(listOperationalJobStatesV1().test_success).not.toBe(state)
    expect(operations.logCronHealth).toHaveBeenCalledWith(expect.objectContaining({
      cronName: 'test_success',
      status: 'ok',
    }))
  })

  it('skips overlap and keeps the first execution authoritative', async () => {
    let release!: (value: string) => void
    const first = runOperationalJobV1('test_overlap', () => new Promise((resolve) => {
      release = resolve
    }))
    await Promise.resolve()

    await expect(runOperationalJobV1('test_overlap', async () => 'second')).resolves.toBeNull()
    release('first')
    await expect(first).resolves.toBe('first')

    expect(operations.opsLog).toHaveBeenCalledWith('info', 'job_skipped_overlap', {
      operation: 'test_overlap',
    })
    expect(operations.logCronHealth).toHaveBeenCalledWith({
      cronName: 'test_overlap',
      status: 'skipped',
      durationMs: 0,
    })
  })

  it('contains failures while retaining the last error for health reporting', async () => {
    await expect(runOperationalJobV1('test_failure', async () => {
      throw new Error('boom')
    })).resolves.toBeNull()

    expect(getOperationalJobStateV1('test_failure')).toMatchObject({
      isRunning: false,
      lastError: 'boom',
    })
    expect(operations.opsLog).toHaveBeenCalledWith('error', 'job_failed', {
      operation: 'test_failure',
      error: 'boom',
    })
  })

  it('clears every registered interval during shutdown', () => {
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)
    const first = { id: 1 } as unknown as NodeJS.Timeout
    const second = { id: 2 } as unknown as NodeJS.Timeout
    registerOperationalIntervalV1(first)
    registerOperationalIntervalV1(second)

    clearOperationalIntervalsV1()

    expect(clear).toHaveBeenNthCalledWith(1, first)
    expect(clear).toHaveBeenNthCalledWith(2, second)
    clear.mockRestore()
  })
})

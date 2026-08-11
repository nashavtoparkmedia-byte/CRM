import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getRecentConfigChanges: vi.fn(),
  validateAllConfigs: vi.fn(),
  validateCronSchedules: vi.fn(),
}))

vi.mock('@/lib/config-validator', () => mocks)

import {
  listRecentConfigurationChangesV1,
  validateOperationalConfigurationV1,
  validateOperationalCronSchedulesV1,
} from './operational-configuration-health'

beforeEach(() => vi.clearAllMocks())

describe('Configuration operational health capability', () => {
  it('delegates the two read-only validation operations without widening them', () => {
    const configuration = { valid: true, errors: [], checkedRules: 4, timestamp: '2026-08-11T00:00:00.000Z' }
    const schedules = { valid: true, errors: [], schedules: 15 }
    mocks.validateAllConfigs.mockReturnValue(configuration)
    mocks.validateCronSchedules.mockReturnValue(schedules)

    expect(validateOperationalConfigurationV1()).toBe(configuration)
    expect(validateOperationalCronSchedulesV1()).toBe(schedules)
    expect(mocks.validateAllConfigs).toHaveBeenCalledOnce()
    expect(mocks.validateCronSchedules).toHaveBeenCalledOnce()
  })

  it('delegates only the bounded recent-change query', async () => {
    const changes = [{ id: 1, parameterName: 'threshold', previousValue: '1', newValue: '2', changedAt: new Date(0), changedBy: null }]
    mocks.getRecentConfigChanges.mockResolvedValue(changes)

    await expect(listRecentConfigurationChangesV1(10)).resolves.toBe(changes)
    expect(mocks.getRecentConfigChanges).toHaveBeenCalledWith(10)
  })
})

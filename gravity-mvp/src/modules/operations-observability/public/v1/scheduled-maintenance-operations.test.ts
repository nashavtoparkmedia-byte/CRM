import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runIntegrity, runRetention, runStability } = vi.hoisted(() => ({
    runIntegrity: vi.fn(),
    runRetention: vi.fn(),
    runStability: vi.fn(),
}))

vi.mock('@/lib/IntegrityChecker', () => ({
    IntegrityChecker: { runAll: runIntegrity },
}))
vi.mock('@/lib/RetentionCleanup', () => ({
    RetentionCleanup: { runAll: runRetention },
}))
vi.mock('@/lib/stability-check', () => ({
    runStabilityCheck: runStability,
}))

import {
    runDailyOperationalStabilityCheckV1,
    runOperationalIntegrityCheckV1,
    runScheduledRetentionCleanupV1,
} from './scheduled-maintenance-operations'

describe('Operations scheduled maintenance capabilities', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.unstubAllEnvs()
    })

    it('runs the complete integrity plan without caller-supplied scope', async () => {
        const report = { issues: [] }
        runIntegrity.mockResolvedValueOnce(report)

        await expect(runOperationalIntegrityCheckV1()).resolves.toBe(report)
        expect(runIntegrity).toHaveBeenCalledOnce()
        expect(runIntegrity).toHaveBeenCalledWith()
    })

    it('maps only the exact true deployment switch to retention dry-run', async () => {
        runRetention.mockResolvedValue({ deletedMessages: 0 })

        vi.stubEnv('RETENTION_DRY_RUN', 'true')
        await runScheduledRetentionCleanupV1()
        vi.stubEnv('RETENTION_DRY_RUN', 'TRUE')
        await runScheduledRetentionCleanupV1()

        expect(runRetention.mock.calls).toEqual([[true], [false]])
    })

    it('fixes scheduled stability checks to the daily scope', async () => {
        const report = { scope: 'daily', status: 'stable' }
        runStability.mockResolvedValueOnce(report)

        await expect(runDailyOperationalStabilityCheckV1()).resolves.toBe(report)
        expect(runStability).toHaveBeenCalledOnce()
        expect(runStability).toHaveBeenCalledWith('daily')
    })
})

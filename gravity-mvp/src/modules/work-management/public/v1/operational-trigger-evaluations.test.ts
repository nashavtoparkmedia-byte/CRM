import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    calculateRootCauseTrends: vi.fn(),
    detectRootCausePatterns: vi.fn(),
    enforceMandatoryFollowup: vi.fn(),
    evaluateAutoClose: vi.fn(),
    evaluateEscalations: vi.fn(),
    evaluateSLAEscalation: vi.fn(),
}))

vi.mock('@/lib/triggers', () => operations)

import {
    calculateOperationalRootCauseTrendsV1,
    detectOperationalRootCausePatternsV1,
    enforceOperationalMandatoryFollowupV1,
    evaluateOperationalAutoCloseV1,
    evaluateOperationalFollowupEscalationsV1,
    evaluateOperationalSlaEscalationV1,
} from './operational-trigger-evaluations'

describe('Work operational trigger evaluations', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it.each([
        ['auto-close', evaluateOperationalAutoCloseV1, operations.evaluateAutoClose],
        ['mandatory follow-up', enforceOperationalMandatoryFollowupV1, operations.enforceMandatoryFollowup],
        ['follow-up escalations', evaluateOperationalFollowupEscalationsV1, operations.evaluateEscalations],
        ['SLA escalation', evaluateOperationalSlaEscalationV1, operations.evaluateSLAEscalation],
        ['root-cause patterns', detectOperationalRootCausePatternsV1, operations.detectRootCausePatterns],
        ['root-cause trends', calculateOperationalRootCauseTrendsV1, operations.calculateRootCauseTrends],
    ])('delegates the fixed %s plan without caller input', async (_name, capability, implementation) => {
        const result = { marker: _name }
        implementation.mockResolvedValueOnce(result)

        await expect(capability()).resolves.toBe(result)
        expect(implementation).toHaveBeenCalledOnce()
        expect(implementation).toHaveBeenCalledWith()
    })
})

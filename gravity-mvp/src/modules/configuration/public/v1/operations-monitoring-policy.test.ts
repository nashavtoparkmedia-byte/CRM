import { describe, expect, it } from 'vitest'

import {
    FAILURE_DETECTION_CONFIG_V1,
    PERFORMANCE_MONITORING_CONFIG_V1,
} from './operations-monitoring-policy'

describe('Configuration operations monitoring policy', () => {
    it('preserves the exact failure detection thresholds as immutable policy', () => {
        expect(FAILURE_DETECTION_CONFIG_V1).toEqual({
            windowHours: 24,
            warningConsecutiveErrors: 2,
            criticalConsecutiveErrors: 5,
            warningErrorRatePct: 20,
            criticalErrorRatePct: 50,
            staleWarningHours: 2,
            staleCriticalHours: 6,
        })
        expect(Object.isFrozen(FAILURE_DETECTION_CONFIG_V1)).toBe(true)
    })

    it('preserves the exact performance thresholds as immutable policy', () => {
        expect(PERFORMANCE_MONITORING_CONFIG_V1).toEqual({
            defaultSlowThresholdMs: 5000,
            cronSlowThresholdMs: 30000,
            apiSlowThresholdMs: 3000,
            querySlowThresholdMs: 2000,
            maxLogEntries: 10000,
            retentionDays: 7,
        })
        expect(Object.isFrozen(PERFORMANCE_MONITORING_CONFIG_V1)).toBe(true)
    })
})

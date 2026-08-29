export const FAILURE_DETECTION_CONFIG_V1 = Object.freeze({
    windowHours: 24,
    warningConsecutiveErrors: 2,
    criticalConsecutiveErrors: 5,
    warningErrorRatePct: 20,
    criticalErrorRatePct: 50,
    staleWarningHours: 2,
    staleCriticalHours: 6,
})

export const PERFORMANCE_MONITORING_CONFIG_V1 = Object.freeze({
    defaultSlowThresholdMs: 5000,
    cronSlowThresholdMs: 30000,
    apiSlowThresholdMs: 3000,
    querySlowThresholdMs: 2000,
    maxLogEntries: 10000,
    retentionDays: 7,
})

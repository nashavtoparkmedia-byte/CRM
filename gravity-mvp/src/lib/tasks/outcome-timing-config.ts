/**
 * Intervention outcome completion activity configuration.
 * Measures completion recency and cadence, not fictional resolution timing.
 */

export const OUTCOME_TIMING_CONFIG = {
    /** Minimum completed interventions required to show stats */
    minCompletedForStats: 3,
    /** Days to consider for recent completion count */
    recentPeriodDays: 7,
}

export interface OutcomeTimingResult {
    status: 'available' | 'insufficient_data'
    completedCount: number
    recentCount: number
    avgPerDay: number
    newestDaysAgo: number
}

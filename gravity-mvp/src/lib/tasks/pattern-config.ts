/**
 * Pattern detection thresholds.
 * Adjustable without schema changes.
 */
export const PATTERN_THRESHOLDS = {
    /** Minimum occurrences to trigger early warning (yellow) */
    warningThreshold: 3,
    /** Minimum occurrences of the same rootCause to be considered a pattern (orange) */
    patternThreshold: 5,
    /** Time window in hours to look for patterns */
    patternWindowHours: 2,
    /** Time window in hours for trend comparison (current vs previous period) */
    trendWindowHours: 2,
}

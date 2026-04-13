/**
 * Pattern detection thresholds.
 * Adjustable without schema changes.
 */
export const PATTERN_THRESHOLDS = {
    /** Minimum occurrences of the same rootCause to be considered a pattern */
    patternThreshold: 5,
    /** Time window in hours to look for patterns */
    patternWindowHours: 2,
}

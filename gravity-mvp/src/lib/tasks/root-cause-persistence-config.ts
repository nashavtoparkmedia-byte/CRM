/**
 * Root cause persistence configuration.
 * Determines when a root cause is considered chronically recurring.
 */

export const ROOT_CAUSE_PERSISTENCE_CONFIG = {
    /** Number of days to analyze for persistence */
    periodDays: 7,
    /** Minimum distinct calendar days a cause must appear to be flagged as persistent */
    minPersistentDays: 3,
    /** Maximum persistent causes to display */
    maxDisplay: 5,
}

export interface PersistentRootCause {
    cause: string
    label: string
    totalCount: number
    distinctDays: number
    periodDays: number
}

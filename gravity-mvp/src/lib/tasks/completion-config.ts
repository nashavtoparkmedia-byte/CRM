/**
 * Completion quality thresholds.
 * Adjustable without schema changes.
 */
export const COMPLETION_THRESHOLDS = {
    /** Minimum minutes between creation and close to be considered valid */
    minCompletionMinutes: 5,
}

/**
 * Check if a task was closed suspiciously fast.
 */
export function isFastClose(createdAt: Date, resolvedAt: Date): boolean {
    const minutes = (resolvedAt.getTime() - createdAt.getTime()) / 60000
    return minutes < COMPLETION_THRESHOLDS.minCompletionMinutes
}

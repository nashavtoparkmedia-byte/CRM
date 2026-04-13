/**
 * Workload thresholds for manager overload detection.
 * Adjustable without schema changes.
 */
export const WORKLOAD_THRESHOLDS = {
    /** Maximum active tasks before a manager is considered overloaded */
    maxActiveTasks: 30,
    /** Maximum overdue tasks before a manager is considered overloaded */
    maxOverdueTasks: 5,
}

/**
 * Check if a manager is overloaded based on their task counts.
 */
export function isManagerOverloaded(active: number, overdue: number): boolean {
    return active > WORKLOAD_THRESHOLDS.maxActiveTasks
        || overdue > WORKLOAD_THRESHOLDS.maxOverdueTasks
}

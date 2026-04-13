/**
 * Response time thresholds for manager reaction monitoring.
 * Adjustable without schema changes.
 */
export const RESPONSE_THRESHOLDS = {
    /** Maximum acceptable response time in minutes */
    maxResponseMinutes: 15,
}

/** Contact event types that count as "first response" */
export const CONTACT_EVENT_TYPES = ['called', 'wrote', 'message_sent', 'contacted']

/**
 * Check if a response time is considered late.
 */
export function isLateResponse(responseMinutes: number): boolean {
    return responseMinutes > RESPONSE_THRESHOLDS.maxResponseMinutes
}

/**
 * Format response time for display.
 */
export function formatResponseTime(minutes: number): string {
    if (minutes < 1) return 'меньше минуты'
    if (minutes < 60) return `${Math.round(minutes)} мин`
    const hours = Math.floor(minutes / 60)
    const remainingMin = Math.round(minutes % 60)
    if (remainingMin === 0) return `${hours}ч`
    return `${hours}ч ${remainingMin}мин`
}

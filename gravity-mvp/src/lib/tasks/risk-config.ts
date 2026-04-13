/**
 * Risk detection thresholds.
 * Adjustable without schema changes.
 */
export const RISK_THRESHOLDS = {
    /** Contact attempts that trigger high risk */
    highRiskAttempts: 3,
    /** Contact attempts that trigger medium risk */
    mediumRiskAttempts: 2,
    /** SLA warning window in minutes (medium risk when SLA < this) */
    slaWarningMinutes: 120,
}

export type RiskLevel = 'low' | 'medium' | 'high'

/**
 * Evaluate risk level for a task based on its properties.
 *
 * High risk: attempts >= 3, or reopened, or no contact and double response threshold exceeded
 * Medium risk: attempts = 2, or SLA approaching (< 2 hours)
 * Low risk: everything else
 */
export function evaluateTaskRisk(params: {
    attempts: number
    isReopened: boolean
    hasContact: boolean
    createdAt: Date
    slaDeadline: Date | null
    responseThresholdMinutes: number
}): RiskLevel {
    const { attempts, isReopened, hasContact, createdAt, slaDeadline, responseThresholdMinutes } = params
    const now = new Date()

    // High risk conditions
    if (attempts >= RISK_THRESHOLDS.highRiskAttempts) return 'high'
    if (isReopened) return 'high'
    if (!hasContact) {
        const minutesSinceCreation = (now.getTime() - createdAt.getTime()) / 60000
        if (minutesSinceCreation > responseThresholdMinutes * 2) return 'high'
    }

    // Medium risk conditions
    if (attempts >= RISK_THRESHOLDS.mediumRiskAttempts) return 'medium'
    if (slaDeadline) {
        const minutesUntilSla = (slaDeadline.getTime() - now.getTime()) / 60000
        if (minutesUntilSla > 0 && minutesUntilSla < RISK_THRESHOLDS.slaWarningMinutes) return 'medium'
    }

    return 'low'
}

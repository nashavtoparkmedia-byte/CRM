import {
    calculateRootCauseTrends,
    detectRootCausePatterns,
    enforceMandatoryFollowup,
    evaluateAutoClose,
    evaluateEscalations,
    evaluateSLAEscalation,
} from '@/lib/triggers'

export async function evaluateOperationalAutoCloseV1() {
    return evaluateAutoClose()
}

export async function enforceOperationalMandatoryFollowupV1() {
    return enforceMandatoryFollowup()
}

export async function evaluateOperationalFollowupEscalationsV1() {
    return evaluateEscalations()
}

export async function evaluateOperationalSlaEscalationV1() {
    return evaluateSLAEscalation()
}

export async function detectOperationalRootCausePatternsV1() {
    return detectRootCausePatterns()
}

export async function calculateOperationalRootCauseTrendsV1() {
    return calculateRootCauseTrends()
}

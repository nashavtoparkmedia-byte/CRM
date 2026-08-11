export { CAPACITY_CONFIG, computeTeamCapacity } from '@/lib/tasks/capacity-config'
export type { TeamCapacityResult } from '@/lib/tasks/capacity-config'

export { COMPLETION_THRESHOLDS, isFastClose } from '@/lib/tasks/completion-config'

export {
  INTERVENTION_ACTIONS,
  INTERVENTION_ACTION_LABELS,
} from '@/lib/tasks/intervention-action-config'
export type { InterventionAction } from '@/lib/tasks/intervention-action-config'

export {
  INTERVENTION_AGING_CONFIG,
  computeManagerInterventionAgingHours,
  isInterventionAging,
} from '@/lib/tasks/intervention-aging-config'
export type { InterventionAgingResult } from '@/lib/tasks/intervention-aging-config'

export {
  INTERVENTION_REASON_COLORS,
  INTERVENTION_REASON_LABELS,
  buildInterventionReasons,
} from '@/lib/tasks/intervention-config'
export type { InterventionReason } from '@/lib/tasks/intervention-config'

export {
  EFFECTIVENESS_THRESHOLDS,
  INTERVENTION_OUTCOME_COLORS,
  INTERVENTION_OUTCOME_CONFIG,
  INTERVENTION_OUTCOME_LABELS,
  evaluateOutcome,
} from '@/lib/tasks/intervention-outcome-config'
export type { InterventionOutcome } from '@/lib/tasks/intervention-outcome-config'

export {
  HEALTH_HISTORY_CONFIG,
  HEALTH_SCORE_CONFIG,
  RISK_PERSISTENCE_CONFIG,
  STABILITY_CONFIG,
  calculateHealthTrend,
  calculateManagerHealthScore,
  computeRiskPersistence,
  computeTeamRiskProfile,
  computeTeamStability,
  isSustainedDecline,
  updateDeclineStreak,
} from '@/lib/tasks/manager-health-config'
export type {
  HealthHistoryPoint,
  HealthLevel,
  HealthScoreBreakdown,
  HealthSnapshot,
  HealthTrend,
  PreviousHealthData,
  RiskPersistenceResult,
  TeamRiskProfileResult,
  TeamStabilityResult,
} from '@/lib/tasks/manager-health-config'

export { OUTCOME_TIMING_CONFIG } from '@/lib/tasks/outcome-timing-config'
export type { OutcomeTimingResult } from '@/lib/tasks/outcome-timing-config'

export { PATTERN_THRESHOLDS } from '@/lib/tasks/pattern-config'

export {
  RELIABILITY_CONFIG,
  computeProcessReliability,
} from '@/lib/tasks/reliability-config'
export type { ProcessReliabilityResult } from '@/lib/tasks/reliability-config'

export {
  CONTACT_EVENT_TYPES,
  RESPONSE_THRESHOLDS,
  isLateResponse,
} from '@/lib/tasks/response-config'

export { RISK_THRESHOLDS, evaluateTaskRisk } from '@/lib/tasks/risk-config'

export { getRootCauseLabel } from '@/lib/tasks/root-cause-config'

export { ROOT_CAUSE_PERSISTENCE_CONFIG } from '@/lib/tasks/root-cause-persistence-config'
export type { PersistentRootCause } from '@/lib/tasks/root-cause-persistence-config'

export {
  VOLATILITY_CONFIG,
  computeOperationalVolatility,
} from '@/lib/tasks/volatility-config'
export type { OperationalVolatilityResult } from '@/lib/tasks/volatility-config'

export { WORKLOAD_THRESHOLDS, isManagerOverloaded } from '@/lib/tasks/workload-config'

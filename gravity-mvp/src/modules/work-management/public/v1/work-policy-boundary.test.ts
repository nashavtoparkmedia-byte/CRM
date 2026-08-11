import { describe, expect, it } from 'vitest'

import { getScenario, getStage } from './scenario-catalog'
import {
  INTERVENTION_ACTIONS,
  INTERVENTION_ACTION_LABELS,
  RESPONSE_THRESHOLDS,
  isLateResponse,
  isManagerOverloaded,
} from './team-operational-policy'

describe('Work Management public policy views', () => {
  it('preserves the read-only scenario lookup semantics', () => {
    expect(getScenario('churn')?.label).toBe('Отток')
    expect(getStage('churn', 'detected')).toMatchObject({
      id: 'detected',
      slaHours: 24,
      recommendedNext: 'contacting',
    })
    expect(getScenario('missing')).toBeUndefined()
  })

  it('preserves operational threshold and vocabulary behavior', () => {
    expect(isLateResponse(RESPONSE_THRESHOLDS.maxResponseMinutes + 1)).toBe(true)
    expect(isManagerOverloaded(100, 0)).toBe(true)
    expect(INTERVENTION_ACTIONS).toContain('coaching')
    expect(INTERVENTION_ACTION_LABELS.coaching).toBeTruthy()
  })
})

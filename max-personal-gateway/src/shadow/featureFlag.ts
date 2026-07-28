import { OUTBOUND_SHADOW_PLANNING_ACCOUNTS } from './constants.ts'

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export { OUTBOUND_SHADOW_PLANNING_ACCOUNTS }

export function isOutboundShadowPlanningEnabled(accountId: string, raw: string | undefined): boolean {
  if (!ACCOUNT_ID_PATTERN.test(accountId) || accountId === '*' || raw === undefined || raw === '') return false
  const enabled = new Set<string>()
  for (const token of raw.split(',')) {
    if (!ACCOUNT_ID_PATTERN.test(token) || token === '*' || token !== token.trim()) return false
    enabled.add(token)
  }
  return enabled.has(accountId)
}

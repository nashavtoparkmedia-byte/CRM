const VARIABLE = 'MAX_SHADOW_COMPARISON_ENABLED'

export function shadowComparisonEnabled(accountId: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  if (accountId.length === 0 || accountId !== accountId.trim()) return false
  const raw = environment[VARIABLE]
  if (raw === undefined || raw.trim() === '') return false
  const values = raw.split(',').map(value => value.trim()).filter(Boolean)
  if (values.some(value => value === '*' || value === 'true' || value === '1' || value === 'all')) return false
  return new Set(values).has(accountId)
}

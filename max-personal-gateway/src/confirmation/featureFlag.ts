import { MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED } from './constants.ts'

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export { MAX_PROVIDER_CONFIRMATION_MATCHER_ENABLED }

export function isProviderConfirmationMatcherEnabled(accountId: string, raw: string | undefined): boolean {
  if (!ACCOUNT_ID_PATTERN.test(accountId) || raw === undefined || raw === '') return false
  const enabled = new Set<string>()
  for (const token of raw.split(',')) {
    if (token === '' || token !== token.trim() || !ACCOUNT_ID_PATTERN.test(token)) return false
    enabled.add(token)
  }
  return enabled.has(accountId)
}

export const MAX_RAW_JOURNAL_FEATURE_FLAG = 'MAX_RAW_JOURNAL_ENABLED'

export interface RawJournalFeatureFlag {
  isEnabled(accountId: string): boolean
}

export function createRawJournalFeatureFlag(accountAllowlist?: string): RawJournalFeatureFlag {
  const values = (accountAllowlist ?? '').split(',').map(value => value.trim()).filter(Boolean)
  const validAccountId = (value: string): boolean =>
    /^(?!true$|false$)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/i.test(value)
  const enabledAccounts = values.every(validAccountId) ? new Set(values) : new Set<string>()

  return {
    isEnabled(accountId: string): boolean {
      return validAccountId(accountId) && enabledAccounts.has(accountId)
    },
  }
}

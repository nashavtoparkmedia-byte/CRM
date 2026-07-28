export const TEXT_SENDER_CONTRACT_ACCOUNTS = 'MAX_PERSONAL_TEXT_SENDER_CONTRACT_ACCOUNTS'
export const TEXT_SENDER_PHYSICAL_ACCOUNTS = 'MAX_PERSONAL_TEXT_SENDER_PHYSICAL_ACCOUNTS'

const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function exactEnabled(accountId: string, raw: string | undefined): boolean {
  if (!ACCOUNT.test(accountId) || accountId === '*' || raw === undefined || raw === '') return false
  const entries = raw.split(',')
  if (entries.some(entry => !ACCOUNT.test(entry) || entry === '*' || entry !== entry.trim())) return false
  return new Set(entries).has(accountId)
}

export function textSenderFeatureFlags(accountId: string, environment: Readonly<Record<string, string | undefined>>): { readonly contract: boolean; readonly physical: boolean } {
  return Object.freeze({
    contract: exactEnabled(accountId, environment[TEXT_SENDER_CONTRACT_ACCOUNTS]),
    physical: exactEnabled(accountId, environment[TEXT_SENDER_PHYSICAL_ACCOUNTS]),
  })
}

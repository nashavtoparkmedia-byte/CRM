export const MAX_PERSONAL_LIVE_CAPTURE_FEATURE_FLAG = 'MAX_PERSONAL_LIVE_CAPTURE_ENABLED'

const validAccount = (value: string): boolean =>
  /^(?!true$|false$)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/i.test(value)

export function isLiveCaptureEnabled(accountAllowlist: string | undefined, accountId: string): boolean {
  if (!validAccount(accountId)) return false
  const values = (accountAllowlist ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (values.length === 0 || !values.every(validAccount)) return false
  return new Set(values).has(accountId)
}

// Fleet's one representation of a stored driving licence (ВУ) for a reader
// (Owner D2, OD-03). Every Fleet answer that carries a licence passes it
// through maskDriverLicenceV1 with the caller's licence view, so masking
// happens on the server, before anything leaves Fleet.
//
// The view is Contacts' ContactReadAuthorityQuery.v1 answer, never Fleet's
// choice. Only an exact 'full' shows the stored licence; anything else (last4,
// a missing view, a typo) shows at most the last four characters.

/** What a reader sees in place of the hidden characters. */
export const DRIVER_LICENCE_MASK_V1 = '••••'

/**
 * The last four characters are shown only when at least this many letters and
 * digits stand in the licence, so that at least four stay hidden. A shorter
 * stored value is shown fully masked.
 */
export const DRIVER_LICENCE_MIN_MASKABLE_LENGTH_V1 = 8

/**
 * A licence as Fleet compares it: letters and digits only, upper case. Null for
 * a value that holds none. Shared by the stored side and the typed side, so a
 * licence matches however it was spaced or cased.
 */
export function driverLicenceKeyV1(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.toUpperCase().replace(/[^0-9A-ZА-ЯЁ]/gu, '')
  return key === '' ? null : key
}

/**
 * The stored licence as `licenceView` allows: the stored text for 'full', the
 * last four letters or digits behind the mask for anything else, null when
 * nothing is stored.
 */
export function maskDriverLicenceV1(stored: unknown, licenceView: unknown): string | null {
  if (typeof stored !== 'string') return null
  const text = stored.trim()
  if (text === '') return null
  if (licenceView === 'full') return text
  const key = driverLicenceKeyV1(text)
  if (key === null || key.length < DRIVER_LICENCE_MIN_MASKABLE_LENGTH_V1) return DRIVER_LICENCE_MASK_V1
  return `${DRIVER_LICENCE_MASK_V1} ${key.slice(-4)}`
}

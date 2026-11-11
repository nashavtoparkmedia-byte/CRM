/**
 * Unified phone normalization utilities for Contact Model.
 * Single source of truth for phone format: E.164 (+79221234567, +998901234567)
 */

/**
 * The assigned ITU-T E.164 country calling codes. The set is prefix-free, so a
 * number starts with at most one of them. '7' (Russia, Kazakhstan) is listed
 * for completeness; the Russian national rule below decides those numbers.
 */
const E164_COUNTRY_CODES_V1: ReadonlySet<string> = new Set([
  '1', '7',
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66',
  '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98',
  '211', '212', '213', '216', '218',
  '220', '221', '222', '223', '224', '225', '226', '227', '228', '229',
  '230', '231', '232', '233', '234', '235', '236', '237', '238', '239',
  '240', '241', '242', '243', '244', '245', '246', '247', '248', '249',
  '250', '251', '252', '253', '254', '255', '256', '257', '258',
  '260', '261', '262', '263', '264', '265', '266', '267', '268', '269',
  '290', '291', '297', '298', '299',
  '350', '351', '352', '353', '354', '355', '356', '357', '358', '359',
  '370', '371', '372', '373', '374', '375', '376', '377', '378', '379',
  '380', '381', '382', '383', '385', '386', '387', '389',
  '420', '421', '423',
  '500', '501', '502', '503', '504', '505', '506', '507', '508', '509',
  '590', '591', '592', '593', '594', '595', '596', '597', '598', '599',
  '670', '672', '673', '674', '675', '676', '677', '678', '679',
  '680', '681', '682', '683', '685', '686', '687', '688', '689', '690', '691', '692',
  '850', '852', '853', '855', '856', '870', '880', '886',
  '960', '961', '962', '963', '964', '965', '966', '967', '968',
  '970', '971', '972', '973', '974', '975', '976', '977',
  '992', '993', '994', '995', '996', '998',
])

/** The country calling code a digit string starts with, or null. */
export function e164CountryCodeV1(digits: string): string | null {
  for (const length of [1, 2, 3]) {
    const prefix = digits.slice(0, length)
    if (prefix.length === length && E164_COUNTRY_CODES_V1.has(prefix)) return prefix
  }
  return null
}

/** E.164 allows at most 15 digits, country code included. */
const E164_MAX_DIGITS_V1 = 15
/** The shortest number kept after an explicit «+» or «00». */
const E164_MIN_EXPLICIT_DIGITS_V1 = 8
/** The shortest bare international number kept: a country code and a full national number. */
const E164_MIN_BARE_DIGITS_V1 = 11

/**
 * Normalize a phone input to E.164 (+79221234567, +998901234567).
 * Returns null for input that is not a phone number.
 *
 * - Russian numbers keep exactly the rule they always had: 11 digits starting
 *   with 7 or 8 (with or without «+»: «+8 9xx» is a common slip) and 10 digits
 *   are read as +7. Every stored Russian value therefore still equals a fresh
 *   normalization.
 * - Any other number is kept digit for digit when it starts with an assigned
 *   country code: after an explicit «+» or «00» with 8–15 digits, or bare with
 *   11–15 digits when the code is neither 7 nor 8 (998…, 996…, 374…).
 * - Nothing is ever synthesized: a number is never cut down to «+7 and the last
 *   ten digits». A 12+-digit input whose code is 7, or a bare one starting with
 *   8 (a Russian number with an extension, or two numbers in one field), is not
 *   a phone: null.
 */
export function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null

  const trimmed = raw.trim()
  const viaZeroZero = trimmed.startsWith('00')
  const explicitInternational = trimmed.startsWith('+') || viaZeroZero
  const allDigits = raw.replace(/\D/g, '')
  const digits = viaZeroZero ? allDigits.slice(2) : allDigits
  if (digits.length === 0) return null

  // The Russian national rule, unchanged.
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) return `+7${digits.slice(1)}`
  if (digits.length === 10) return `+7${digits}`

  // Every other number is kept as it is, or refused.
  const shortest = explicitInternational ? E164_MIN_EXPLICIT_DIGITS_V1 : E164_MIN_BARE_DIGITS_V1
  if (digits.length < shortest || digits.length > E164_MAX_DIGITS_V1) return null
  const countryCode = e164CountryCodeV1(digits)
  if (countryCode === null || countryCode === '7') return null
  if (!explicitInternational && digits.startsWith('8')) return null
  return `+${digits}`
}

/**
 * Parse externalChatId into channel and externalId.
 * Format: "channel:externalId" (e.g. "whatsapp:79221234567")
 */
export function parseExternalChatId(externalChatId: string): { channel: string; externalId: string } {
  const colonIndex = externalChatId.indexOf(':')

  if (colonIndex === -1) {
    return { channel: 'max', externalId: externalChatId }
  }

  const channel = externalChatId.slice(0, colonIndex)
  const externalId = externalChatId.slice(colonIndex + 1)

  const knownChannels = ['whatsapp', 'telegram', 'max', 'phone']
  if (knownChannels.includes(channel)) {
    return { channel, externalId }
  }

  // Legacy MAX format: "max_name:ИМЯ"
  if (channel === 'max_name') {
    return { channel: 'max', externalId: `name_${externalId}` }
  }

  return { channel: 'unknown', externalId: externalChatId }
}

/** Check if a string looks like a phone number (10-15 digits). */
export function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 10 && digits.length <= 15
}

/** Strip non-digit characters for search. */
export function stripToDigits(input: string): string {
  return input.replace(/\D/g, '')
}

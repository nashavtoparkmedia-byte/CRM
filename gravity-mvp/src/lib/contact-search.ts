export const MIN_CONTACT_PHONE_SEARCH_DIGITS = 7
export const CONTACT_SEARCH_INVALIDATE_EVENT = 'crm:contact-search-invalidated'

export function normalizeContactSearchText(value?: string | null): string {
  return (value || '')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
}

export function normalizeContactPhoneDigits(value?: string | null): string {
  const digits = (value || '').replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`
  if (digits.length === 10) return `7${digits}`
  return digits
}

export function isPhoneLikeContactSearch(value: string): boolean {
  return /^[\d\s+()\-]+$/.test(value.trim())
}

export function expandYoVariants(value: string): string[] {
  const normalized = normalizeContactSearchText(value)
  const positions = [...normalized].reduce<number[]>((result, char, index) => {
    if (char === 'е') result.push(index)
    return result
  }, [])
  if (positions.length === 0 || positions.length > 6) return [normalized]

  const variants = new Set<string>([normalized])
  for (let mask = 1; mask < (1 << positions.length); mask += 1) {
    const chars = [...normalized]
    positions.forEach((position, bit) => {
      if (mask & (1 << bit)) chars[position] = 'ё'
    })
    variants.add(chars.join(''))
  }
  return [...variants]
}

export function expandContactSearchTextVariants(value: string): string[] {
  const variants = new Set<string>()

  for (const base of expandYoVariants(value)) {
    if (!base) continue

    variants.add(base)
    variants.add(base.toLocaleUpperCase('ru-RU'))

    const chars = [...base]
    const [first, ...rest] = chars
    if (first) {
      variants.add(`${first.toLocaleUpperCase('ru-RU')}${rest.join('')}`)
    }
  }

  return [...variants]
}

interface ConversationSearchInput {
  name?: string | null
  channel?: string | null
  externalChatId?: string | null
  driver?: {
    fullName?: string | null
    phone?: string | null
  } | null
  contact?: {
    displayName?: string | null
    canonicalSummary?: {
      displayName?: string | null
      displayTitle?: string | null
      primaryPhone?: string | null
      currentMainDriverProfile?: {
        fullName?: string | null
        phone?: string | null
      } | null
      providerIdentities?: Array<{
        channel?: string | null
        externalId?: string | null
        displayName?: string | null
      }>
    } | null
  } | null
}

export function conversationMatchesContactSearch(
  conversation: ConversationSearchInput,
  rawQuery: string,
): boolean {
  const query = rawQuery.trim()
  if (!query) return true

  const summary = conversation.contact?.canonicalSummary
  if (isPhoneLikeContactSearch(query)) {
    const normalizedQuery = normalizeContactPhoneDigits(query)
    if (normalizedQuery.length < MIN_CONTACT_PHONE_SEARCH_DIGITS) return false
    const phoneCandidates = [
      summary?.primaryPhone,
      summary?.currentMainDriverProfile?.phone,
      conversation.driver?.phone,
      conversation.externalChatId,
      conversation.name,
      conversation.contact?.displayName,
      ...(summary?.providerIdentities || []).map(identity => identity.externalId),
    ]
    return phoneCandidates.some(candidate => {
      const normalizedCandidate = normalizeContactPhoneDigits(candidate)
      return normalizedCandidate.length >= MIN_CONTACT_PHONE_SEARCH_DIGITS
        && normalizedCandidate.includes(normalizedQuery)
    })
  }

  const tokens = normalizeContactSearchText(query).split(' ').filter(Boolean)
  const searchableText = [
    summary?.displayName,
    summary?.displayTitle,
    summary?.currentMainDriverProfile?.fullName,
    conversation.driver?.fullName,
    conversation.contact?.displayName,
    conversation.name,
    conversation.channel,
    ...(summary?.providerIdentities || []).flatMap(identity => [identity.displayName, identity.channel]),
  ]
    .map(normalizeContactSearchText)
    .filter(Boolean)
    .join(' ')

  return tokens.every(token => searchableText.includes(token))
}

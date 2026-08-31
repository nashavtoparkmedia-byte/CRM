export const LOCAL_DRIVER_SEARCH_MAX_QUERY_LENGTH_V1 = 120
export const LOCAL_DRIVER_SEARCH_MAX_NAME_TOKENS_V1 = 6
export const LOCAL_DRIVER_SEARCH_MIN_NAME_TOKEN_LENGTH_V1 = 2
export const LOCAL_DRIVER_SEARCH_RESULT_LIMIT_V1 = 10

export type LocalDriverSearchRowV1 = {
  id: string
  yandexDriverId: string | null
  fullName: string
  phone: string | null
}

export type LocalDriverSearchPersistenceInputV1 = {
  phoneDigits: string | null
  nameTokens: string[]
  take: number
}

export interface SearchLocalDriversPersistencePortV1 {
  search(input: LocalDriverSearchPersistenceInputV1): Promise<LocalDriverSearchRowV1[]>
}

export type SearchLocalDriversResultV1 =
  | { status: 'invalid'; drivers: [] }
  | { status: 'ok'; query: string; drivers: LocalDriverSearchRowV1[] }

export type NormalizedDriverSearchQueryV1 =
  | { status: 'invalid' }
  | { status: 'ok'; query: string; phoneDigits: string | null; nameTokens: string[] }

export function normalizeDriverPhoneDigitsV1(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`
  if (digits.length === 10) return `7${digits}`
  return digits
}

export function normalizeDriverSearchQueryV1(queryValue: unknown): NormalizedDriverSearchQueryV1 {
  const query = typeof queryValue === 'string' ? queryValue.trim() : ''
  if (query.length < 3 || query.length > LOCAL_DRIVER_SEARCH_MAX_QUERY_LENGTH_V1) {
    return { status: 'invalid' }
  }

  const rawDigits = query.replace(/\D/g, '')
  const nameTokens = rawDigits.length >= 3
    ? []
    : query.split(/\s+/).map(token => token.trim()).filter(Boolean)
  if (
    rawDigits.length < 3
    && (
      nameTokens.length === 0
      || nameTokens.length > LOCAL_DRIVER_SEARCH_MAX_NAME_TOKENS_V1
      || nameTokens.some(token => token.length < LOCAL_DRIVER_SEARCH_MIN_NAME_TOKEN_LENGTH_V1)
    )
  ) return { status: 'invalid' }

  return {
    status: 'ok',
    query,
    phoneDigits: rawDigits.length >= 3 ? normalizeDriverPhoneDigitsV1(rawDigits) : null,
    nameTokens,
  }
}

export function canonicalDriverNameKeyV1(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .split(/\s+/)
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'ru-RU'))
    .join('\u0000')
}

export function createSearchLocalDriversHandlerV1(port: SearchLocalDriversPersistencePortV1) {
  return async function searchLocalDriversV1(queryValue: unknown): Promise<SearchLocalDriversResultV1> {
    const normalized = normalizeDriverSearchQueryV1(queryValue)
    if (normalized.status === 'invalid') return { status: 'invalid', drivers: [] }

    const drivers = await port.search({
      phoneDigits: normalized.phoneDigits,
      nameTokens: normalized.nameTokens,
      take: LOCAL_DRIVER_SEARCH_RESULT_LIMIT_V1,
    })
    return { status: 'ok', query: normalized.query, drivers }
  }
}

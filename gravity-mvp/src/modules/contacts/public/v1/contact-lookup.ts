// M3A6A ContactLookup.v1 — the reusable Contacts-owned lookup any CRM business
// module can use to find a canonical person.
//
// It answers exactly one question: "which Contact is this?". It does not answer
// "can I reach them now?", "which channel should I use?", "is a message
// deliverable?" or "may I contact them?" — those belong to Messaging, the channel
// domains, ContactReachabilityEvidenceView.v1, ContactIdentityConflictView.v1 and
// a communication-policy capability that does not exist yet.
//
// Consequently a result item carries no provider target, no ProviderAccount, no
// Transport, no ConversationRoute, no Chat, no message state, no reachability and
// no conflict detail. `channels` states only that the Contact currently owns an
// active Contacts-owned identity on that channel.
//
// The title is not computed here. It comes from the provider-neutral projection
// in ContactDisplayPolicy, which shares the canonical precedence with the Contact
// Card and deliberately refuses the provider-external-id fallback, so a provider
// id cannot reach a human-readable field by any path.
//
// How a query matches (amended 2026-11-10, after the Owner's own attempt to find
// a driver by the ФИО and the number shown in the dispatcher profile):
// - A name query is a set of words. «ё» and «е» are one letter, case does not
//   matter, and the words may come in any order. A one-letter word (an initial)
//   is ignored once a longer word is present.
// - A name ranks by how much of it matched: first a name that starts with the
//   first typed word and contains every other one, then a name that contains
//   every typed word in any order, and last, only for three or more typed words,
//   a name that contains all of them but one. That last class is how a full
//   «Фамилия Имя Отчество» copied from a park profile still finds a card that
//   carries no patronymic; each item says which class found it (`match`), so a
//   consumer can say that not every word matched. A match is a search hit and
//   never evidence that two records are one person.
// - A phone query is its digits. A leading 8 typed without «+» is also read as
//   +7, so «8 (999) 100-01-01» finds +79991000101; the digits as typed are still
//   searched too. A stored number equals the query with or without its «+».

import {
  buildProviderNeutralContactDisplayV1,
} from './contact-display-policy'
import { confirmedPersonNameV1, contactAutomationState, phoneEvidenceState } from './contact-evidence-state'
import { stripToDigits } from './phone-identity'

export const CONTACT_LOOKUP_DEFAULT_LIMIT_V1 = 10
export const CONTACT_LOOKUP_MAX_LIMIT_V1 = 25
export const CONTACT_LOOKUP_MIN_TEXT_LENGTH_V1 = 2
export const CONTACT_LOOKUP_MIN_PHONE_DIGITS_V1 = 3
/** Words beyond this many are not searched: a name is never longer. */
export const CONTACT_LOOKUP_MAX_WORDS_V1 = 6

export type ContactLookupItemV1 = {
  /** The canonical Contact id — the only person identifier this contract emits. */
  contactId: string
  displayName: string
  displayTitle: string
  primaryPhone: string | null
  /** Channel names of ACTIVE Contacts identities, sorted and deduplicated. */
  channels: string[]
  /**
   * The rank class that found this item. `name_all_but_one_word` means one typed
   * word is not in the name. A search result always carries it; an item built
   * outside a search, such as a consumer's own fixture, may omit it.
   */
  match?: ContactLookupRankClassV1
}

export type ContactLookupResultV1 = {
  items: ContactLookupItemV1[]
  /** The number of items returned. Never an unbounded count of the table. */
  total: number
  /** True when at least one further unique candidate existed beyond `limit`. */
  truncated: boolean
}

/**
 * A phone query searches digits; a text query searches the display name by words.
 *
 * `digitReadings` are the digit strings a stored number is compared with: the
 * digits as typed and, when they start with 8 and no «+» was typed, the same
 * number read as +7. `words` are folded (NFKC, lower case, «ё» as «е»), unique,
 * in typed order and at most CONTACT_LOOKUP_MAX_WORDS_V1.
 */
export type ContactLookupCriteriaV1 =
  | { kind: 'phone'; digits: string; digitReadings: string[] }
  | { kind: 'text'; text: string; words: string[] }

/**
 * The ranking classes, highest precedence first.
 *
 * Precedence must be decided before truncation, so the port is asked for one
 * class at a time and a lower class is queried only while the budget is unfilled.
 * A single bounded query plus post-hoc classification could let a substring match
 * hide an exact one behind the database's own row limit.
 *
 * - phone_exact: a stored number equals one digit reading, with or without «+».
 * - phone_substring: a stored number contains one digit reading.
 * - name_prefix: the folded name starts with the first word and contains all.
 * - name_all_words: the folded name contains every word, in any order.
 * - name_all_but_one_word: the folded name contains all words but exactly one;
 *   asked only when three or more words were typed.
 */
export const CONTACT_LOOKUP_RANK_CLASSES_V1 = [
  'phone_exact',
  'phone_substring',
  'name_prefix',
  'name_all_words',
  'name_all_but_one_word',
] as const

export type ContactLookupRankClassV1 = typeof CONTACT_LOOKUP_RANK_CLASSES_V1[number]

/**
 * The exact Contacts-owned state the projection needs.
 *
 * Every field is owned by Contacts, so an adapter can satisfy it without reading
 * Chat, Message, Driver, Task, Call, ProviderAccount or Transport. No provider
 * target appears in the shape at all: nothing here needs `externalId`, so the
 * adapter never selects it.
 */
export type ContactLookupSourceV1 = {
  id: string
  displayName: string | null
  displayNameSource?: string | null
  primaryPhoneId?: string | null
  /** Contacts-owned JSON evidence: the canonical pin and the person confirmations. */
  customFields?: unknown
  phones: ReadonlyArray<{
    id: string
    phone: string
    isPrimary?: boolean
    isActive?: boolean
    verifiedAt?: Date | string | null
  }>
  identities: ReadonlyArray<{
    channel: string
    isActive?: boolean
    displayName?: string | null
  }>
}

export interface ContactLookupPortV1 {
  /**
   * Up to `limit` live Contact ids matching one rank class, in any order.
   * Archived Contacts are never returned.
   */
  findContactLookupCandidateIds(
    criteria: ContactLookupCriteriaV1,
    rankClass: ContactLookupRankClassV1,
    limit: number,
  ): Promise<string[]>
  /** One bounded hydration of the given Contact ids. No N+1. */
  findContactLookupSources(contactIds: readonly string[]): Promise<ContactLookupSourceV1[]>
}

/** The limit a caller asked for, clamped to the contract's bounds. */
export function contactLookupLimitV1(requested?: number | null): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return CONTACT_LOOKUP_DEFAULT_LIMIT_V1
  const truncatedValue = Math.trunc(requested)
  if (truncatedValue < 1) return 1
  return Math.min(truncatedValue, CONTACT_LOOKUP_MAX_LIMIT_V1)
}

/**
 * The query, normalized to criteria, or null when no database read is warranted.
 *
 * A blank, malformed, non-string or below-minimum query is refused here so the
 * adapter is never asked for a match that cannot exist.
 */
export function contactLookupCriteriaV1(query: unknown): ContactLookupCriteriaV1 | null {
  if (typeof query !== 'string') return null
  const trimmed = query.trim()
  if (!trimmed) return null
  // A control character never appears in a name or a phone number, and a stored
  // value containing one must not be reachable by searching for it.
  if (/[\u0000-\u001F\u007F]/u.test(trimmed)) return null
  if (/^[\d\s+\-()]+$/u.test(trimmed)) {
    const digits = stripToDigits(trimmed)
    if (digits.length < CONTACT_LOOKUP_MIN_PHONE_DIGITS_V1) return null
    const digitReadings = [digits]
    // «8 999 …» is how a Russian number is usually typed; stored numbers are +7.
    if (!trimmed.startsWith('+') && digits.startsWith('8')) digitReadings.push(`7${digits.slice(1)}`)
    return { kind: 'phone', digits, digitReadings }
  }
  if (trimmed.length < CONTACT_LOOKUP_MIN_TEXT_LENGTH_V1) return null
  const words = contactLookupWordsV1(trimmed)
  return words.length > 0 ? { kind: 'text', text: trimmed.replace(/\s+/gu, ' '), words } : null
}

/**
 * The comparison form of a name: NFKC, lower case, «ё» as «е».
 *
 * The database side applies the same fold to the stored name (see the lookup
 * adapter), so «Пётр» and «Петр» find each other in both directions.
 */
export function contactLookupFoldV1(value: string | null | undefined): string {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е')
}

/**
 * The words of a name query, folded, unique, in typed order.
 *
 * Words are split on anything that is not a letter or a digit, so brackets,
 * dots and hyphens separate words. A one-letter word is an initial and too
 * unspecific to require; it is dropped once any longer word is present, and a
 * query of initials only yields no words at all.
 */
export function contactLookupWordsV1(text: string): string[] {
  const all = contactLookupFoldV1(text).split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 0)
  const unique = [...new Set(all.filter(word => word.length >= 2))]
  return unique.slice(0, CONTACT_LOOKUP_MAX_WORDS_V1)
}

/** The rank classes a given criteria uses, in precedence order. */
export function contactLookupRankClassesV1(
  criteria: ContactLookupCriteriaV1,
): ContactLookupRankClassV1[] {
  if (criteria.kind === 'phone') return ['phone_exact', 'phone_substring']
  return criteria.words.length >= 3
    ? ['name_prefix', 'name_all_words', 'name_all_but_one_word']
    : ['name_prefix', 'name_all_words']
}

/**
 * A locale-independent sort key.
 *
 * `localeCompare` depends on the ambient ICU locale, so two runs of the same
 * query can order two names differently on different hosts. NFKC plus a
 * lower-cased code-point comparison is deterministic everywhere.
 */
export function contactLookupSortKeyV1(value: string | null | undefined): string {
  return String(value ?? '').normalize('NFKC').toLowerCase()
}

function compareBySortKeyThenId(
  left: { sortKey: string; contactId: string },
  right: { sortKey: string; contactId: string },
): number {
  if (left.sortKey !== right.sortKey) return left.sortKey < right.sortKey ? -1 : 1
  if (left.contactId === right.contactId) return 0
  return left.contactId < right.contactId ? -1 : 1
}

/** Active channel names only, deduplicated and deterministically ordered. */
function activeChannelsOf(source: ContactLookupSourceV1): string[] {
  const channels = new Set<string>()
  for (const identity of source.identities) {
    if (identity.isActive === false) continue
    const channel = String(identity.channel ?? '').trim()
    if (channel) channels.add(channel)
  }
  return [...channels].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/**
 * One source row projected to one item.
 *
 * Phone lifecycle comes from the Contacts accessor and the title from the
 * provider-neutral display projection, so neither a second primary-phone rule
 * nor a second name precedence exists here.
 */
export function buildContactLookupItemV1(source: ContactLookupSourceV1): ContactLookupItemV1 {
  const display = buildProviderNeutralContactDisplayV1({
    contact: {
      displayName: source.displayName,
      displayNameSource: source.displayNameSource ?? null,
      primaryPhoneId: source.primaryPhoneId ?? null,
      canonicalPinnedAt: contactAutomationState(source.customFields).canonicalPinnedAt,
      phones: source.phones.map(phone => ({
        id: phone.id,
        phone: phone.phone,
        isPrimary: phone.isPrimary,
        isActive: phone.isActive,
        lifecycle: phoneEvidenceState(source.customFields, phone.id, {
          phone: phone.phone,
          isActive: phone.isActive !== false,
          verifiedAt: phone.verifiedAt ?? null,
        }).lifecycle,
      })),
      identities: source.identities.map(identity => ({
        channel: identity.channel,
        isActive: identity.isActive,
        displayName: identity.displayName ?? null,
      })),
    },
    confirmedPersonName: confirmedPersonNameV1(source.customFields),
  })
  return {
    contactId: source.id,
    displayName: display.displayName,
    displayTitle: display.displayTitle,
    primaryPhone: display.primaryPhone,
    channels: activeChannelsOf(source),
  }
}

const EMPTY_RESULT: ContactLookupResultV1 = { items: [], total: 0, truncated: false }

export function createSearchContactsHandlerV1(port: ContactLookupPortV1) {
  return async (input: { query?: unknown; limit?: number | null } | null | undefined)
  : Promise<ContactLookupResultV1> => {
    const criteria = contactLookupCriteriaV1(input?.query)
    if (criteria === null) return { ...EMPTY_RESULT }
    const limit = contactLookupLimitV1(input?.limit ?? null)

    // One bounded query per rank class, highest first, stopping as soon as one
    // extra unique candidate is known: that proves truncation without letting a
    // lower class hide a higher one behind a database row limit.
    const ranked: Array<{ contactId: string; rank: number }> = []
    const seen = new Set<string>()
    const classes = contactLookupRankClassesV1(criteria)
    for (const [rank, rankClass] of classes.entries()) {
      if (seen.size > limit) break
      const ids = await port.findContactLookupCandidateIds(criteria, rankClass, limit + 1)
      for (const id of ids) {
        const contactId = typeof id === 'string' ? id.trim() : ''
        if (!contactId || seen.has(contactId)) continue
        seen.add(contactId)
        ranked.push({ contactId, rank })
        if (seen.size > limit) break
      }
    }
    if (ranked.length === 0) return { ...EMPTY_RESULT }

    const truncated = ranked.length > limit
    const sources = await port.findContactLookupSources(ranked.map(entry => entry.contactId))
    const itemsById = new Map<string, ContactLookupItemV1>()
    for (const source of sources) {
      if (!source || typeof source.id !== 'string') continue
      itemsById.set(source.id, buildContactLookupItemV1(source))
    }

    const ordered = ranked
      .map(entry => {
        const item = itemsById.get(entry.contactId)
        return item === undefined
          ? null
          : { ...entry, item, sortKey: contactLookupSortKeyV1(item.displayName) }
      })
      .filter((entry): entry is { contactId: string; rank: number; item: ContactLookupItemV1; sortKey: string } =>
        entry !== null)
      .sort((left, right) => (left.rank !== right.rank
        ? left.rank - right.rank
        : compareBySortKeyThenId(left, right)))

    const items = ordered.slice(0, limit).map(entry => ({ ...entry.item, match: classes[entry.rank] }))
    return { items, total: items.length, truncated }
  }
}

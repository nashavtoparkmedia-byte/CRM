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

import {
  buildProviderNeutralContactDisplayV1,
} from './contact-display-policy'
import { confirmedPersonNameV1, contactAutomationState, phoneEvidenceState } from './contact-evidence-state'
import { stripToDigits } from './phone-identity'

export const CONTACT_LOOKUP_DEFAULT_LIMIT_V1 = 10
export const CONTACT_LOOKUP_MAX_LIMIT_V1 = 25
export const CONTACT_LOOKUP_MIN_TEXT_LENGTH_V1 = 2
export const CONTACT_LOOKUP_MIN_PHONE_DIGITS_V1 = 3

export type ContactLookupItemV1 = {
  /** The canonical Contact id — the only person identifier this contract emits. */
  contactId: string
  displayName: string
  displayTitle: string
  primaryPhone: string | null
  /** Channel names of ACTIVE Contacts identities, sorted and deduplicated. */
  channels: string[]
}

export type ContactLookupResultV1 = {
  items: ContactLookupItemV1[]
  /** The number of items returned. Never an unbounded count of the table. */
  total: number
  /** True when at least one further unique candidate existed beyond `limit`. */
  truncated: boolean
}

/** A phone query searches normalized digits; a text query searches the display name. */
export type ContactLookupCriteriaV1 =
  | { kind: 'phone'; digits: string }
  | { kind: 'text'; text: string }

/**
 * The ranking classes, highest precedence first.
 *
 * Precedence must be decided before truncation, so the port is asked for one
 * class at a time and a lower class is queried only while the budget is unfilled.
 * A single bounded query plus post-hoc classification could let a substring match
 * hide an exact one behind the database's own row limit.
 */
export const CONTACT_LOOKUP_RANK_CLASSES_V1 = [
  'phone_exact',
  'phone_substring',
  'name_prefix',
  'name_substring',
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
    return digits.length >= CONTACT_LOOKUP_MIN_PHONE_DIGITS_V1 ? { kind: 'phone', digits } : null
  }
  return trimmed.length >= CONTACT_LOOKUP_MIN_TEXT_LENGTH_V1 ? { kind: 'text', text: trimmed } : null
}

/** The rank classes a given criteria uses, in precedence order. */
export function contactLookupRankClassesV1(
  criteria: ContactLookupCriteriaV1,
): ContactLookupRankClassV1[] {
  return criteria.kind === 'phone'
    ? ['phone_exact', 'phone_substring']
    : ['name_prefix', 'name_substring']
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

    const items = ordered.slice(0, limit).map(entry => entry.item)
    return { items, total: items.length, truncated }
  }
}

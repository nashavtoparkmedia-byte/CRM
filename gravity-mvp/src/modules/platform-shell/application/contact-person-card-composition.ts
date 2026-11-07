// Platform-shell composition (application layer) of the «Карточка человека» page.
//
// Three reads, each owned by its own context, composed here and nowhere else:
//   1. Contacts' ContactPersonCardQuery.v1 — the canonical person, its phones,
//      channel accounts, lineage, conflicts and candidates. It alone decides
//      whether the caller may see anything: no Fleet or Messaging read happens
//      before it answers `confirmed`.
//   2. Fleet Operations' DriverProfilesForContactsQuery.v1 — the persisted park
//      profiles of every Contact in the lineage (and the legacy Yandex link).
//   3. Messaging's ContactConversationsQuery.v1 — the conversation to open per
//      channel, so the page can lead into the existing «Сообщения».
// Fleet and Messaging answers are enrichment: when one of them fails the page is
// still shown, with that block marked partial, never with invented data. Nothing
// here matches, merges or links; it only lays the three answers side by side.
import {
  CONTACT_PERSON_CARD_QUERY_V1,
  type ContactPersonCardResultV1,
  type ContactPersonCardV1,
} from '@/contracts/contacts/v1'
import {
  DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1,
  type DriverProfileForContactV1,
  type DriverProfilesForContactsResultV1,
} from '@/contracts/fleet-operations/v1'
import {
  CONTACT_CONVERSATIONS_QUERY_V1,
  type ContactConversationsResultV1,
} from '@/contracts/messaging/v1'
import { readContactPersonCardV1 } from '@/modules/contacts/public/v1'
import { readDriverProfilesForContactsV1 } from '@/modules/fleet-operations/public/v1'
import { contactConversationsV1 } from '@/modules/messaging/public/v1'

export type ContactPersonCardDriverProfileV1 = DriverProfileForContactV1 & {
  /** Which Contact of the lineage this row was matched through. */
  viaContactId: string
  /** Contacts' legacy main-driver projection names this row. */
  isMainDriver: boolean
  /**
   * The row's own stored link (Driver.contactId) points at a Contact outside
   * this person's whole lineage: a recorded contradiction to show, decided here
   * against the lineage Contacts answered with, never against one lineage id.
   */
  linkContradiction: boolean
}

const LINK_BASIS_PREFERENCE: Record<DriverProfileForContactV1['linkBasis'], number> = { both: 0, contact_link: 1, legacy_yandex_link: 2 }

export type ContactPersonCardConversationV1 = {
  channel: string
  /** The exact Chat.id to open on this channel: the most recent conversation. */
  primaryConversationId: string
  lastActivityAt: string | null
  conversationCount: number
  truncated: boolean
}

export type ContactPersonCardViewV1 = {
  card: ContactPersonCardV1
  driverProfiles: ContactPersonCardDriverProfileV1[]
  conversations: ContactPersonCardConversationV1[]
  /** True when the corresponding enrichment could not be read; the block is then shown as unavailable. */
  partial: { driverProfiles: boolean; conversations: boolean }
}

export type ContactPersonCardLoadResultV1 =
  | { status: 'confirmed'; view: ContactPersonCardViewV1 }
  | { status: 'redirected'; canonicalContactId: string }
  | { status: 'missing' | 'forbidden' | 'refused' }

export type ContactPersonCardCompositionDependenciesV1 = {
  readContactPersonCard: (query: unknown) => Promise<ContactPersonCardResultV1>
  readDriverProfilesForContacts: (query: unknown) => Promise<DriverProfilesForContactsResultV1>
  readContactConversations: (query: unknown) => Promise<ContactConversationsResultV1>
}

async function settle<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await read() }
  } catch (error) {
    console.error('[contact-person-card] enrichment read failed:', error instanceof Error ? error.message : error)
    return { ok: false }
  }
}

export function createContactPersonCardCompositionV1(deps: ContactPersonCardCompositionDependenciesV1) {
  return async function loadContactPersonCardV1(contactId: string): Promise<ContactPersonCardLoadResultV1> {
    const answer = await deps.readContactPersonCard({ contract: CONTACT_PERSON_CARD_QUERY_V1, contactId })
    if (answer.status === 'redirected') return { status: 'redirected', canonicalContactId: answer.canonicalContactId }
    if (answer.status !== 'confirmed') return { status: answer.status }
    const card = answer.card
    const lineageIds = card.lineage.contactIds.length > 0 ? card.lineage.contactIds : [card.contactId]
    const subjects = lineageIds.slice(0, 25).map(id => ({
      contactId: id,
      legacyYandexDriverId: id === card.contactId ? card.legacyYandexDriverId : null,
    }))
    const [profiles, conversations] = await Promise.all([
      settle(() => deps.readDriverProfilesForContacts({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1, subjects })),
      settle(() => deps.readContactConversations({ contract: CONTACT_CONVERSATIONS_QUERY_V1, contactIds: lineageIds.slice(0, 25) })),
    ])
    const driverProfiles: ContactPersonCardDriverProfileV1[] = []
    if (profiles.ok) {
      // The same Driver row can be reached through two lineage ids; it is one
      // profile, kept through its strongest stored link (both > contact_link >
      // legacy_yandex_link) so a legacy match never hides a direct one.
      const byDriver = new Map<string, ContactPersonCardDriverProfileV1>()
      for (const entry of profiles.value.entries) {
        for (const profile of entry.profiles) {
          const candidate: ContactPersonCardDriverProfileV1 = {
            ...profile,
            viaContactId: entry.contactId,
            isMainDriver: profile.driverId === card.mainDriverId,
            linkContradiction: profile.linkedContactId !== null && !lineageIds.includes(profile.linkedContactId),
          }
          const existing = byDriver.get(profile.driverId)
          if (existing === undefined || LINK_BASIS_PREFERENCE[candidate.linkBasis] < LINK_BASIS_PREFERENCE[existing.linkBasis]) {
            byDriver.set(profile.driverId, candidate)
          }
        }
      }
      driverProfiles.push(...byDriver.values())
    }
    const byChannel = new Map<string, ContactPersonCardConversationV1>()
    if (conversations.ok) {
      for (const entry of conversations.value.contacts) {
        if (entry.status !== 'found') continue
        for (const channel of entry.channels) {
          const latest = channel.conversations[0]?.lastActivityAt ?? null
          const existing = byChannel.get(channel.channel)
          if (existing === undefined || (latest ?? '') > (existing.lastActivityAt ?? '')) {
            byChannel.set(channel.channel, {
              channel: channel.channel,
              primaryConversationId: channel.primaryConversationId,
              lastActivityAt: latest,
              conversationCount: (existing?.conversationCount ?? 0) + channel.conversations.length,
              truncated: (existing?.truncated ?? false) || entry.truncated,
            })
          } else {
            existing.conversationCount += channel.conversations.length
            existing.truncated = existing.truncated || entry.truncated
          }
        }
      }
    }
    return {
      status: 'confirmed',
      view: {
        card,
        driverProfiles,
        conversations: [...byChannel.values()].sort((left, right) => (left.channel < right.channel ? -1 : left.channel > right.channel ? 1 : 0)),
        partial: { driverProfiles: !profiles.ok, conversations: !conversations.ok },
      },
    }
  }
}

/** The production composition: every read bound to its own context's public surface. A narrow business function, nothing else crosses. */
export async function loadContactPersonCardV1(contactId: string): Promise<ContactPersonCardLoadResultV1> {
  return createContactPersonCardCompositionV1({
    readContactPersonCard: readContactPersonCardV1,
    readDriverProfilesForContacts: readDriverProfilesForContactsV1,
    readContactConversations: contactConversationsV1,
  })(contactId)
}

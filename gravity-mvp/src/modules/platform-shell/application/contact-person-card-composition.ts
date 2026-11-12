// Platform-shell composition (application layer) of the «Карточка человека» page.
//
// Three reads, each owned by its own context, composed here and nowhere else:
//   1. Contacts' ContactPersonCardQuery.v1 — the canonical person, its phones,
//      channel accounts, lineage, conflicts and candidates. It alone decides
//      whether the caller may see anything: no Fleet or Messaging read happens
//      before it answers `confirmed`.
//   2. Fleet Operations' DriverProfilesForContactsQuery.v3 — the persisted park
//      profiles of every Contact in the lineage (and the legacy Yandex link),
//      with each profile's own phone and employment type (Contact Identity V2),
//      each with its driving licence (ВУ) masked by Fleet on the server for the
//      ВУ view Contacts answered with (since the Owner's decision of 2026-11-11,
//      full for every staff reader role). The view is passed on unchanged; a Fleet
//      answer for any other view is not shown.
//   3. Messaging's ContactConversationsQuery.v1 — the conversation to open per
//      channel, so the page can lead into the existing «Сообщения».
//   4. Identity Access's operator directory — the names of exactly the
//      employees this card's «История связей» names as actors (Security W8),
//      read only when there is one; anyone else stays out of the answer, and an
//      unavailable directory leaves them «сотрудник».
// Fleet and Messaging answers are enrichment: when one of them fails the page is
// still shown, with that block marked partial, never with invented data. Nothing
// here matches, merges or links; it only lays the three answers side by side.
import {
  CONTACT_PERSON_CARD_QUERY_V1,
  type ContactPersonCardResultV1,
  type ContactPersonCardV1,
} from '@/contracts/contacts/v1'
import type { DriverProfileForContactV1 } from '@/contracts/fleet-operations/v1'
import {
  DRIVER_PROFILES_FOR_CONTACTS_QUERY_V3,
  type DriverProfileForContactV3,
  type DriverProfilesForContactsResultV3,
} from '@/contracts/fleet-operations/v3'
import {
  CONTACT_CONVERSATIONS_QUERY_V1,
  type ContactConversationsResultV1,
} from '@/contracts/messaging/v1'
import { readContactPersonCardV1 } from '@/modules/contacts/public/v1'
import { DRIVER_LICENCE_MASK_V1, readDriverProfilesForContactsV3 } from '@/modules/fleet-operations/public/v1'
import { contactConversationsV1 } from '@/modules/messaging/public/v1'
import { listUserIdentitiesV1 } from '@/modules/identity-access/public/v1/user-directory'

export type ContactPersonCardDriverProfileV1 = DriverProfileForContactV3 & {
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
  /** Directory names of exactly the employees the card's history names, by user id. */
  staffNames: Record<string, string>
}

export type ContactPersonCardLoadResultV1 =
  | { status: 'confirmed'; view: ContactPersonCardViewV1 }
  | { status: 'redirected'; canonicalContactId: string }
  | { status: 'missing' | 'forbidden' | 'refused' }

export type ContactPersonCardCompositionDependenciesV1 = {
  readContactPersonCard: (query: unknown) => Promise<ContactPersonCardResultV1>
  readDriverProfilesForContacts: (query: unknown) => Promise<DriverProfilesForContactsResultV3>
  readContactConversations: (query: unknown) => Promise<ContactConversationsResultV1>
  /** Identity Access's operator directory; without it every employee in the history stays «сотрудник». */
  readStaffDirectory?: () => Promise<ReadonlyArray<{ id: string; firstName: string; lastName: string }>>
}

/** Under a last-4 view a shown ВУ is either absent or starts with Fleet's mask. */
function maskedForView(licence: string | null, licenceView: 'full' | 'last4'): boolean {
  return licenceView === 'full' || licence === null || licence.startsWith(DRIVER_LICENCE_MASK_V1)
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
    const licenceView = answer.licenceView === 'full' ? 'full' : 'last4'
    const lineageIds = card.lineage.contactIds.length > 0 ? card.lineage.contactIds : [card.contactId]
    const subjects = lineageIds.slice(0, 25).map(id => ({
      contactId: id,
      legacyYandexDriverId: id === card.contactId ? card.legacyYandexDriverId : null,
    }))
    const staffIds = [...new Set(card.linkHistory.flatMap(event => (event.actor.kind === 'staff' ? [event.actor.userId] : [])))]
    const [profiles, conversations, directory] = await Promise.all([
      settle(() => deps.readDriverProfilesForContacts({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V3, licenceView, subjects })),
      settle(() => deps.readContactConversations({ contract: CONTACT_CONVERSATIONS_QUERY_V1, contactIds: lineageIds.slice(0, 25) })),
      staffIds.length === 0 || deps.readStaffDirectory === undefined
        ? Promise.resolve({ ok: false as const })
        : settle(deps.readStaffDirectory),
    ])
    const staffNames: Record<string, string> = {}
    if (directory.ok) {
      for (const user of directory.value) {
        if (!staffIds.includes(user.id)) continue
        const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()
        if (name !== '') staffNames[user.id] = name
      }
    }
    const driverProfiles: ContactPersonCardDriverProfileV1[] = []
    // Fleet masks for the view it echoes. An answer for another view, or one
    // that shows a last-4 reader an unmasked ВУ, is never shown: the block is
    // marked unavailable instead.
    const profilesShown = profiles.ok
      && profiles.value.licenceView === licenceView
      && profiles.value.entries.every(entry => entry.profiles.every(profile => maskedForView(profile.licence, licenceView)))
    if (profiles.ok && !profilesShown) console.error('[contact-person-card] Fleet answered outside the reader\'s ВУ view; profiles withheld')
    if (profiles.ok && profilesShown) {
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
    // Messaging answers a merged-away lineage id with its own conversations AND
    // those of the canonical survivor, so one Chat.id can arrive under two
    // entries. A conversation is counted once, by its exact id; the channel's
    // primary conversation is the most recent one across the whole lineage.
    const byChannel = new Map<string, { view: ContactPersonCardConversationV1; conversationIds: Set<string> }>()
    if (conversations.ok) {
      for (const entry of conversations.value.contacts) {
        if (entry.status !== 'found') continue
        for (const channel of entry.channels) {
          const latest = channel.conversations[0]?.lastActivityAt ?? null
          let accumulated = byChannel.get(channel.channel)
          if (accumulated === undefined) {
            accumulated = {
              view: { channel: channel.channel, primaryConversationId: channel.primaryConversationId, lastActivityAt: latest, conversationCount: 0, truncated: false },
              conversationIds: new Set<string>(),
            }
            byChannel.set(channel.channel, accumulated)
          } else if ((latest ?? '') > (accumulated.view.lastActivityAt ?? '')) {
            accumulated.view.primaryConversationId = channel.primaryConversationId
            accumulated.view.lastActivityAt = latest
          }
          for (const conversation of channel.conversations) accumulated.conversationIds.add(conversation.conversationId)
          accumulated.view.conversationCount = accumulated.conversationIds.size
          accumulated.view.truncated = accumulated.view.truncated || entry.truncated
        }
      }
    }
    return {
      status: 'confirmed',
      view: {
        card,
        driverProfiles,
        conversations: [...byChannel.values()].map(accumulated => accumulated.view)
          .sort((left, right) => (left.channel < right.channel ? -1 : left.channel > right.channel ? 1 : 0)),
        partial: { driverProfiles: !profilesShown, conversations: !conversations.ok },
        staffNames,
      },
    }
  }
}

/** The production composition: every read bound to its own context's public surface. A narrow business function, nothing else crosses. */
export async function loadContactPersonCardV1(contactId: string): Promise<ContactPersonCardLoadResultV1> {
  return createContactPersonCardCompositionV1({
    readContactPersonCard: readContactPersonCardV1,
    readDriverProfilesForContacts: readDriverProfilesForContactsV3,
    readContactConversations: contactConversationsV1,
    readStaffDirectory: listUserIdentitiesV1,
  })(contactId)
}

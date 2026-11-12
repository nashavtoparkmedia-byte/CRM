import { describe, expect, it, vi } from 'vitest'
import { CONTACT_PERSON_CARD_RESULT_V1, type ContactPersonCardV1 } from '@/contracts/contacts/v1'
import { DRIVER_PROFILES_FOR_CONTACTS_RESULT_V3 as DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2, type DriverProfileForContactV3 as DriverProfileForContactV2 } from '@/contracts/fleet-operations/v3'
import { CONTACT_CONVERSATIONS_RESULT_V1 } from '@/contracts/messaging/v1'
import { createContactPersonCardCompositionV1 } from './contact-person-card-composition'

function card(overrides: Partial<ContactPersonCardV1> = {}): ContactPersonCardV1 {
  return {
    contactId: 'c-1',
    displayName: 'Иванов Иван',
    displayTitle: 'Иванов Иван · +7 999 000-00-01',
    primaryPhone: '+7 999 000-00-01',
    displayNameSource: 'yandex',
    source: 'yandex',
    personConfirmation: { state: 'confirmed', confirmedPersonName: 'Иванов Иван', confirmedClusterKeyCount: 1, representativeDriverId: 'd-1' },
    mainDriverId: 'd-1',
    legacyYandexDriverId: 'yd-1',
    phones: [],
    channels: [],
    lineage: { canonicalContactId: 'c-1', contactIds: ['c-1', 'c-old'], mergedFromCount: 1, mergeHistory: [] },
    conflicts: [],
    hasOpenConflict: false,
    hasPersonBlockingConflict: false,
    candidates: [],
    automation: { doNotMerge: false, canonicalPinned: false, mergeRecoveryState: null },
    isArchived: false,
    linkHistory: [],
    ...overrides,
  }
}

function profile(overrides: Partial<DriverProfileForContactV2> & { driverId: string }): DriverProfileForContactV2 {
  return {
    linkBasis: 'contact_link', linkedContactId: 'c-1', externalParkId: 'p', externalDriverProfileId: 'x', parkName: 'Парк', fullName: 'Иванов Иван',
    personResolutionStatus: 'vu_clustered', personKeyType: 'normalized_vu', sourceFreshness: 'fresh', sourceState: 'current',
    lastObservedAt: null, legalRole: null, workStatus: null, currentStatus: null, segment: null, dismissedAt: null, licence: '•••• 5678', phone: null, isSelfEmployed: null, employmentType: null,
    ...overrides,
  }
}

describe('loadContactPersonCardV1', () => {
  it('asks Fleet and Messaging only after Contacts confirmed, for the whole lineage, and marks the main driver', async () => {
    const calls: string[] = []
    const load = createContactPersonCardCompositionV1({
      async readContactPersonCard() { calls.push('contacts'); return { contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'confirmed', card: card(), licenceView: 'last4' } },
      async readDriverProfilesForContacts(query) {
        calls.push('fleet')
        expect(query).toEqual({ contract: 'fleet_operations.DriverProfilesForContactsQuery.v3', licenceView: 'last4', subjects: [
          { contactId: 'c-1', legacyYandexDriverId: 'yd-1' }, { contactId: 'c-old', legacyYandexDriverId: null },
        ] })
        return { contract: DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2, licenceView: 'last4', entries: [
          { contactId: 'c-1', profiles: [profile({ driverId: 'd-1' }), profile({ driverId: 'd-2', parkName: 'Парк 2' })] },
          { contactId: 'c-old', profiles: [profile({ driverId: 'd-2', parkName: 'Парк 2' }), profile({ driverId: 'd-3' })] },
        ] }
      },
      async readContactConversations(query) {
        calls.push('messaging')
        expect(query).toEqual({ contract: 'messaging.ContactConversationsQuery.v1', contactIds: ['c-1', 'c-old'] })
        return { contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts: [
          { contactId: 'c-1', status: 'found', channels: [
            { channel: 'telegram', primaryConversationId: 'chat-tg-new', conversations: [{ conversationId: 'chat-tg-new', lastActivityAt: '2026-03-01T00:00:00.000Z' }] },
          ], latestConversationId: 'chat-tg-new', truncated: false },
          { contactId: 'c-old', status: 'found', channels: [
            { channel: 'telegram', primaryConversationId: 'chat-tg-old', conversations: [{ conversationId: 'chat-tg-old', lastActivityAt: '2026-01-01T00:00:00.000Z' }] },
            { channel: 'whatsapp', primaryConversationId: 'chat-wa', conversations: [{ conversationId: 'chat-wa', lastActivityAt: null }] },
          ], latestConversationId: 'chat-tg-old', truncated: true },
        ] } as never
      },
    })
    const result = await load('c-1')
    expect(calls[0]).toBe('contacts')
    expect(result.status).toBe('confirmed')
    if (result.status !== 'confirmed') throw new Error('unreachable')
    expect(result.view.driverProfiles.map(p => [p.driverId, p.viaContactId, p.isMainDriver, p.linkContradiction])).toEqual([
      ['d-1', 'c-1', true, false], ['d-2', 'c-1', false, false], ['d-3', 'c-old', false, false],
    ])
    expect(result.view.conversations).toEqual([
      { channel: 'telegram', primaryConversationId: 'chat-tg-new', lastActivityAt: '2026-03-01T00:00:00.000Z', conversationCount: 2, truncated: true },
      { channel: 'whatsapp', primaryConversationId: 'chat-wa', lastActivityAt: null, conversationCount: 1, truncated: true },
    ])
    expect(result.view.partial).toEqual({ driverProfiles: false, conversations: false })
  })

  it('counts a conversation once when Messaging answers a merged-away id with the survivor\'s conversations too', async () => {
    const load = createContactPersonCardCompositionV1({
      async readContactPersonCard() { return { contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'confirmed', card: card(), licenceView: 'last4' } },
      async readDriverProfilesForContacts() { return { contract: DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2, licenceView: 'last4', entries: [] } },
      async readContactConversations() {
        // The real ContactConversationsQuery.v1: the canonical id gets its own chats, the
        // merged-away id gets its own AND the canonical survivor's (linkedIds = [id, canonical]).
        return { contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts: [
          { contactId: 'c-1', status: 'found', canonicalContactId: 'c-1', channels: [
            { channel: 'telegram', primaryConversationId: 'chat-tg-new', conversations: [{ conversationId: 'chat-tg-new', lastActivityAt: '2026-03-01T00:00:00.000Z' }] },
            { channel: 'whatsapp', primaryConversationId: 'chat-wa', conversations: [{ conversationId: 'chat-wa', lastActivityAt: '2026-02-01T00:00:00.000Z' }] },
          ], latestConversationId: 'chat-tg-new', truncated: false },
          { contactId: 'c-old', status: 'found', canonicalContactId: 'c-1', channels: [
            { channel: 'telegram', primaryConversationId: 'chat-tg-new', conversations: [
              { conversationId: 'chat-tg-new', lastActivityAt: '2026-03-01T00:00:00.000Z' },
              { conversationId: 'chat-tg-old', lastActivityAt: '2026-01-01T00:00:00.000Z' },
            ] },
            { channel: 'whatsapp', primaryConversationId: 'chat-wa', conversations: [{ conversationId: 'chat-wa', lastActivityAt: '2026-02-01T00:00:00.000Z' }] },
          ], latestConversationId: 'chat-tg-new', truncated: false },
        ] } as never
      },
    })
    const result = await load('c-1')
    if (result.status !== 'confirmed') throw new Error('unreachable')
    expect(result.view.conversations).toEqual([
      { channel: 'telegram', primaryConversationId: 'chat-tg-new', lastActivityAt: '2026-03-01T00:00:00.000Z', conversationCount: 2, truncated: false },
      { channel: 'whatsapp', primaryConversationId: 'chat-wa', lastActivityAt: '2026-02-01T00:00:00.000Z', conversationCount: 1, truncated: false },
    ])
  })

  it('decides a link contradiction against the whole lineage and keeps the strongest link of a duplicated row', async () => {
    const load = createContactPersonCardCompositionV1({
      async readContactPersonCard() { return { contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'confirmed', card: card(), licenceView: 'last4' } },
      async readDriverProfilesForContacts() {
        return { contract: DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2, licenceView: 'last4', entries: [
          // reached first through the canonical id by the legacy link, pointing at the merged-away lineage member: no contradiction
          { contactId: 'c-1', profiles: [profile({ driverId: 'd-merged', linkBasis: 'legacy_yandex_link', linkedContactId: 'c-old' }), profile({ driverId: 'd-foreign', linkBasis: 'legacy_yandex_link', linkedContactId: 'c-stranger' })] },
          // the same row again through its own Contact link: the direct link wins
          { contactId: 'c-old', profiles: [profile({ driverId: 'd-merged', linkBasis: 'contact_link', linkedContactId: 'c-old' })] },
        ] }
      },
      async readContactConversations() { return { contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts: [] } },
    })
    const result = await load('c-1')
    if (result.status !== 'confirmed') throw new Error('unreachable')
    expect(result.view.driverProfiles.map(p => [p.driverId, p.linkBasis, p.viaContactId, p.linkContradiction])).toEqual([
      ['d-merged', 'contact_link', 'c-old', false],
      ['d-foreign', 'legacy_yandex_link', 'c-1', true],
    ])
  })

  it('passes through forbidden, missing, refused and redirected without reading Fleet or Messaging', async () => {
    for (const status of ['forbidden', 'missing', 'refused'] as const) {
      const calls: string[] = []
      const load = createContactPersonCardCompositionV1({
        async readContactPersonCard() { return { contract: CONTACT_PERSON_CARD_RESULT_V1, status } },
        async readDriverProfilesForContacts() { calls.push('fleet'); throw new Error('unreachable') },
        async readContactConversations() { calls.push('messaging'); throw new Error('unreachable') },
      })
      expect(await load('c-1')).toEqual({ status })
      expect(calls).toEqual([])
    }
    const load = createContactPersonCardCompositionV1({
      async readContactPersonCard() { return { contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'redirected', canonicalContactId: 'c-9' } },
      async readDriverProfilesForContacts() { throw new Error('unreachable') },
      async readContactConversations() { throw new Error('unreachable') },
    })
    expect(await load('c-1')).toEqual({ status: 'redirected', canonicalContactId: 'c-9' })
  })

  it('shows the card with a partial block when an enrichment read fails, never inventing rows', async () => {
    const load = createContactPersonCardCompositionV1({
      async readContactPersonCard() { return { contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'confirmed', card: card(), licenceView: 'last4' } },
      async readDriverProfilesForContacts() { throw new Error('fleet down') },
      async readContactConversations() { return { contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts: [{ contactId: 'c-1', status: 'not_found' }, { contactId: 'c-old', status: 'not_found' }] } },
    })
    const result = await load('c-1')
    if (result.status !== 'confirmed') throw new Error('unreachable')
    expect(result.view.driverProfiles).toEqual([])
    expect(result.view.conversations).toEqual([])
    expect(result.view.partial).toEqual({ driverProfiles: true, conversations: false })
  })

  it('asks Fleet for the ВУ view Contacts answered with, and shows the masked ВУ as Fleet gave it', async () => {
    for (const licenceView of ['full', 'last4'] as const) {
      const asked: unknown[] = []
      const load = createContactPersonCardCompositionV1({
        async readContactPersonCard() { return { contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'confirmed', card: card(), licenceView } },
        async readDriverProfilesForContacts(query) {
          asked.push((query as { licenceView: unknown }).licenceView)
          const licence = licenceView === 'full' ? '99 12 345678' : '•••• 5678'
          return { contract: DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2, licenceView, entries: [{ contactId: 'c-1', profiles: [profile({ driverId: 'd-1', licence })] }] }
        },
        async readContactConversations() { return { contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts: [] } },
      })
      const result = await load('c-1')
      if (result.status !== 'confirmed') throw new Error('unreachable')
      expect(asked).toEqual([licenceView])
      expect(result.view.driverProfiles.map(p => p.licence)).toEqual([licenceView === 'full' ? '99 12 345678' : '•••• 5678'])
      expect(result.view.partial.driverProfiles).toBe(false)
    }
  })

  it('a card answer without a ВУ view asks Fleet for the last-4 view, never the full one', async () => {
    const asked: unknown[] = []
    const load = createContactPersonCardCompositionV1({
      async readContactPersonCard() { return { contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'confirmed', card: card() } as never },
      async readDriverProfilesForContacts(query) {
        asked.push((query as { licenceView: unknown }).licenceView)
        return { contract: DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2, licenceView: 'last4', entries: [] }
      },
      async readContactConversations() { return { contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts: [] } },
    })
    await load('c-1')
    expect(asked).toEqual(['last4'])
  })

  it('withholds the profiles when Fleet answers for another view or shows a last-4 reader an unmasked ВУ', async () => {
    const answers = [
      { contract: DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2, licenceView: 'full' as const, entries: [{ contactId: 'c-1', profiles: [profile({ driverId: 'd-1', licence: '99 12 345678' })] }] },
      { contract: DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2, licenceView: 'last4' as const, entries: [{ contactId: 'c-1', profiles: [profile({ driverId: 'd-1', licence: '99 12 345678' })] }] },
    ]
    for (const answer of answers) {
      const load = createContactPersonCardCompositionV1({
        async readContactPersonCard() { return { contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'confirmed', card: card(), licenceView: 'last4' } },
        async readDriverProfilesForContacts() { return answer },
        async readContactConversations() { return { contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts: [] } },
      })
      const result = await load('c-1')
      if (result.status !== 'confirmed') throw new Error('unreachable')
      expect(result.view.driverProfiles).toEqual([])
      expect(result.view.partial.driverProfiles).toBe(true)
      expect(JSON.stringify(result)).not.toContain('345678')
    }
  })
})

describe('«История связей» names the employees it shows (Security W8)', () => {
  const staffEvent = (userId: string) => ({ kind: 'phone_added_or_verified' as const, at: '2026-11-12T08:00:00.000Z', subject: null, detail: null, mode: 'manual' as const, actor: { kind: 'staff' as const, userId } })

  async function load(linkHistory: unknown[], directory?: () => Promise<Array<{ id: string; firstName: string; lastName: string }>>) {
    const calls: string[] = []
    const compose = createContactPersonCardCompositionV1({
      async readContactPersonCard() {
        return { contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'confirmed', card: card({ linkHistory: linkHistory as never }), licenceView: 'full' } as never
      },
      async readDriverProfilesForContacts(query) {
        return { contract: DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2, licenceView: (query as { licenceView: 'full' }).licenceView, entries: [] } as never
      },
      async readContactConversations() { return { contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts: [] } },
      ...(directory ? { readStaffDirectory: async () => { calls.push('directory'); return directory() } } : {}),
    })
    return { result: await compose('c-1'), calls }
  }

  it('answers names for exactly the employees in the history, and nobody else', async () => {
    const { result, calls } = await load([staffEvent('u1'), staffEvent('u1')], async () => [
      { id: 'u1', firstName: 'Анна', lastName: 'Смирнова' },
      { id: 'u9', firstName: 'Чужой', lastName: 'Сотрудник' },
    ])
    expect(calls).toEqual(['directory'])
    expect(result).toMatchObject({ status: 'confirmed', view: { staffNames: { u1: 'Анна Смирнова' } } })
    expect(JSON.stringify(result)).not.toContain('Чужой')
  })

  it('does not read the directory when no employee is named, and survives a directory failure', async () => {
    const quiet = await load([{ ...staffEvent('x'), actor: { kind: 'system' } }], async () => [{ id: 'u1', firstName: 'Анна', lastName: 'Смирнова' }])
    expect(quiet.calls).toEqual([])
    expect(quiet.result).toMatchObject({ view: { staffNames: {} } })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failed = await load([staffEvent('u1')], async () => { throw new Error('directory down') })
    log.mockRestore()
    expect(failed.result).toMatchObject({ status: 'confirmed', view: { staffNames: {} } })
  })
})

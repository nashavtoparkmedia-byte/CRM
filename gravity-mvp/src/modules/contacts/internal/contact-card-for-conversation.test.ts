import { describe, expect, test } from 'vitest'

import {
  CONTACT_CARD_FOR_CONVERSATION_QUERY_V1,
  CONTACT_CARD_FOR_CONVERSATION_RESULT_V1,
  ContactCardForConversationValidationError,
  type ContactCardForConversationResultV1,
} from '@/contracts/contacts/v1'

import { formatContactPhone } from '../public/v1/contact-display-policy'
import {
  buildContactCardV1,
  createContactCardForConversationHandlerV1,
  type ContactCardAuthorityPortV1,
  type ContactCardPrincipalV1,
  type ContactCardSourceV1,
} from './contact-card-for-conversation'

const ADMIN: ContactCardPrincipalV1 = { kind: 'integration_admin_session' }

/** One person per Contact; every value is a sentinel that must never appear in a foreign answer. */
function person(id: string, overrides: Partial<ContactCardSourceV1> = {}): ContactCardSourceV1 {
  const tag = id.toUpperCase()
  return {
    id,
    displayName: `${tag}-NAME-SENTINEL`,
    displayNameSource: 'provider',
    primaryPhoneId: `${id}-phone-1`,
    isArchived: false,
    customFields: {},
    phones: [
      { id: `${id}-phone-1`, phone: id === 'contact-a' ? '79990000001' : id === 'contact-b' ? '79990000002' : '79990000003', isActive: true, lifecycle: 'current' },
    ],
    identities: [
      { id: `${id}-identity-tg`, channel: 'telegram', isActive: true, metadata: {}, displayName: `${tag}-TG-SENTINEL` },
    ],
    mergedFromCount: 0,
    confirmedPersonName: null,
    ...overrides,
  }
}

const PEOPLE = { 'contact-a': person('contact-a'), 'contact-b': person('contact-b'), 'contact-c': person('contact-c') }
const SENTINELS = [
  'contact-a', 'contact-b', 'contact-c',
  'CONTACT-A', 'CONTACT-B', 'CONTACT-C',
  '79990000001', '79990000002', '79990000003',
  '999 000-00-01', '999 000-00-02', '999 000-00-03',
]

const resolved = (contactId: string) => ({ contract: 'messaging.ResolveConversationContactResult.v1', status: 'resolved', contactId })
const status = (value: string) => ({ contract: 'messaging.ResolveConversationContactResult.v1', status: value })

function query(chatId: string) {
  return { contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId }
}

/**
 * A recorded world. `answers` lists RCQ1's answers in call order; `onSourceRead`
 * runs inside the card read, between the two resolutions, to model a change.
 */
function harness(options: {
  principal?: unknown
  mayReadConversation?: (principal: ContactCardPrincipalV1, chatId: string) => boolean
  mayReadContact?: (principal: ContactCardPrincipalV1, contactId: string) => boolean
  answers?: unknown[]
  contacts?: Record<string, ContactCardSourceV1 | null>
  onSourceRead?: () => void
}) {
  const calls = {
    principal: 0,
    mayReadConversation: [] as string[],
    mayReadContact: [] as string[],
    resolve: [] as string[],
    source: [] as string[],
  }
  const answers = [...(options.answers ?? [])]
  const contacts: Record<string, ContactCardSourceV1 | null> = options.contacts ?? PEOPLE
  const authority: ContactCardAuthorityPortV1 = {
    async currentPrincipal() {
      calls.principal += 1
      return (options.principal === undefined ? ADMIN : options.principal) as ContactCardPrincipalV1 | null
    },
    async mayReadConversation(principal, chatId) {
      calls.mayReadConversation.push(chatId)
      return options.mayReadConversation ? options.mayReadConversation(principal, chatId) : true
    },
    async mayReadContact(principal, contactId) {
      calls.mayReadContact.push(contactId)
      return options.mayReadContact ? options.mayReadContact(principal, contactId) : true
    },
  }
  const read = createContactCardForConversationHandlerV1({
    authority,
    async resolveConversation(chatId) {
      calls.resolve.push(chatId)
      if (answers.length === 0) throw new Error('unexpected RCQ1 call')
      return answers.shift()
    },
    cardSource: {
      async findContactCardSource(contactId) {
        calls.source.push(contactId)
        options.onSourceRead?.()
        return contacts[contactId] ?? null
      },
    },
  })
  return { read, calls }
}

/** A non-confirmed answer is exactly {contract, status}: no Contact, no conversation, no reason, no sentinel. */
function expectNoData(result: ContactCardForConversationResultV1, expected: string) {
  expect(result).toEqual({ contract: CONTACT_CARD_FOR_CONVERSATION_RESULT_V1, status: expected })
  expect(Object.keys(result).sort()).toEqual(['contract', 'status'])
  const text = JSON.stringify(result)
  for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel)
}

describe('ContactCardForConversationQuery.v1 — confirmed', () => {
  test('1. an exact, stable association returns the minimal card of exactly that Contact', async () => {
    const { read, calls } = harness({ answers: [resolved('contact-a'), resolved('contact-a')] })
    const result = await read(query('chat-1'))
    expect(result).toEqual({
      contract: CONTACT_CARD_FOR_CONVERSATION_RESULT_V1,
      status: 'confirmed',
      card: {
        contactId: 'contact-a',
        displayName: 'CONTACT-A-NAME-SENTINEL',
        primaryPhone: formatContactPhone('79990000001'),
        phoneCount: 1,
        channels: [{ channel: 'telegram', identityCount: 1, hasActiveIdentity: true, hasOpenIdentityConflict: false }],
        hasOpenIdentityConflict: false,
        mergedFromCount: 0,
      },
    })
    expect(calls.resolve).toEqual(['chat-1', 'chat-1'])
    expect(calls.source).toEqual(['contact-a'])
    expect(calls.mayReadConversation).toEqual(['chat-1'])
    expect(calls.mayReadContact).toEqual(['contact-a'])
    const text = JSON.stringify(result)
    for (const foreign of ['contact-b', 'contact-c', 'CONTACT-B', 'CONTACT-C', '79990000002', '79990000003']) {
      expect(text).not.toContain(foreign)
    }
  })

  test('the card carries no identity id, provider name, source or merge-recovery detail', async () => {
    const { read } = harness({ answers: [resolved('contact-a'), resolved('contact-a')] })
    const result = await read(query('chat-1'))
    if (result.status !== 'confirmed') throw new Error(result.status)
    expect(Object.keys(result.card).sort()).toEqual([
      'channels', 'contactId', 'displayName', 'hasOpenIdentityConflict', 'mergedFromCount', 'phoneCount', 'primaryPhone',
    ])
    expect(JSON.stringify(result)).not.toContain('contact-a-identity-tg')
    expect(JSON.stringify(result)).not.toContain('TG-SENTINEL')
    expect(JSON.stringify(result)).not.toContain('provider')
  })
})

describe('ContactCardForConversationQuery.v1 — non-confirmed answers carry no data', () => {
  test('2. a missing Chat is `missing`, and no Contact is consulted', async () => {
    const { read, calls } = harness({ answers: [status('not_found')] })
    expectNoData(await read(query('chat-unknown')), 'missing')
    expect(calls.mayReadContact).toEqual([])
    expect(calls.source).toEqual([])
  })

  test('3. a Contact that RCQ1 still names but no longer exists is `missing`', async () => {
    const { read, calls } = harness({
      answers: [resolved('contact-a'), resolved('contact-a')],
      contacts: { 'contact-a': null },
    })
    expectNoData(await read(query('chat-1')), 'missing')
    expect(calls.source).toEqual(['contact-a'])
  })

  test('3b. an archived Contact is `missing`, never shown', async () => {
    const { read } = harness({
      answers: [resolved('contact-a'), resolved('contact-a')],
      contacts: { 'contact-a': person('contact-a', { isArchived: true }) },
    })
    expectNoData(await read(query('chat-1')), 'missing')
  })

  test('4. an unlinked conversation is `unresolved`, and no Contact is read', async () => {
    const { read, calls } = harness({ answers: [status('unresolved')] })
    expectNoData(await read(query('chat-1')), 'unresolved')
    expect(calls.mayReadContact).toEqual([])
    expect(calls.source).toEqual([])
  })

  test('5. a conversation whose recorded resolution matched several people is `conflict`, and no Contact is read', async () => {
    const { read, calls } = harness({ answers: [status('ambiguous')] })
    expectNoData(await read(query('chat-1')), 'conflict')
    expect(calls.mayReadContact).toEqual([])
    expect(calls.source).toEqual([])
  })

  test.each([
    ['a resolved answer without a Contact id', { status: 'resolved' }],
    ['a resolved answer with a padded Contact id', resolved(' contact-a')],
    ['a resolved answer with an empty Contact id', resolved('')],
    ['a resolved answer with a numeric Contact id', { status: 'resolved', contactId: 7 }],
    ['an unknown status', status('maybe')],
    ['a missing status', { contactId: 'contact-a' }],
    ['null', null],
    ['an array', [resolved('contact-a')]],
    ['a string', 'resolved'],
  ])('6. %s from the resolver is `refused`, and no Contact is read', async (_label, bad) => {
    const { read, calls } = harness({ answers: [bad] })
    expectNoData(await read(query('chat-1')), 'refused')
    expect(calls.mayReadContact).toEqual([])
    expect(calls.source).toEqual([])
  })

  test('6b. a source that has been merged away while RCQ1 still named it is `refused`', async () => {
    const { read } = harness({
      answers: [resolved('contact-a'), resolved('contact-a')],
      contacts: { 'contact-a': person('contact-a', { customFields: { mergedIntoContactId: 'contact-c' } }) },
    })
    expectNoData(await read(query('chat-1')), 'refused')
  })

  test('6c. a source that is not the Contact asked for is `refused`', async () => {
    const { read } = harness({
      answers: [resolved('contact-a'), resolved('contact-a')],
      contacts: { 'contact-a': person('contact-b') },
    })
    expectNoData(await read(query('chat-1')), 'refused')
  })
})

describe('ContactCardForConversationQuery.v1 — authorization', () => {
  test('7. a conversation the principal may not read is `forbidden` before RCQ1 is asked', async () => {
    const { read, calls } = harness({
      answers: [resolved('contact-a'), resolved('contact-a')],
      mayReadConversation: (_principal, chatId) => chatId !== 'chat-foreign',
    })
    expectNoData(await read(query('chat-foreign')), 'forbidden')
    expect(calls.resolve).toEqual([])
    expect(calls.source).toEqual([])
  })

  test('8. cross-person: a readable conversation that resolves to a Contact the principal may not read is `forbidden`, nothing of it is read', async () => {
    const { read, calls } = harness({
      answers: [resolved('contact-b'), resolved('contact-b')],
      mayReadContact: (_principal, contactId) => contactId === 'contact-a',
    })
    expectNoData(await read(query('chat-1')), 'forbidden')
    expect(calls.mayReadContact).toEqual(['contact-b'])
    expect(calls.source).toEqual([])
  })

  describe('9. cross-fleet', () => {
    const FLEET_OF_CHAT: Record<string, string> = { 'chat-park-1': 'park-1', 'chat-park-2': 'park-2', 'chat-mixed': 'park-1' }
    const FLEET_OF_CONTACT: Record<string, string> = { 'contact-a': 'park-1', 'contact-b': 'park-2' }
    const scoped = { kind: 'fleet_scoped_operator', fleet: 'park-1' }
    const fleetOf = (principal: ContactCardPrincipalV1) => (principal as typeof scoped).fleet

    test('a conversation of another fleet is `forbidden` before RCQ1', async () => {
      const { read, calls } = harness({
        principal: scoped,
        answers: [resolved('contact-b')],
        mayReadConversation: (principal, chatId) => FLEET_OF_CHAT[chatId] === fleetOf(principal),
        mayReadContact: (principal, contactId) => FLEET_OF_CONTACT[contactId] === fleetOf(principal),
      })
      expectNoData(await read(query('chat-park-2')), 'forbidden')
      expect(calls.resolve).toEqual([])
      expect(calls.source).toEqual([])
    })

    test('a same-fleet conversation linked to another fleet\'s Contact is `forbidden` before the Contact is read', async () => {
      const { read, calls } = harness({
        principal: scoped,
        answers: [resolved('contact-b'), resolved('contact-b')],
        mayReadConversation: (principal, chatId) => FLEET_OF_CHAT[chatId] === fleetOf(principal),
        mayReadContact: (principal, contactId) => FLEET_OF_CONTACT[contactId] === fleetOf(principal),
      })
      expectNoData(await read(query('chat-mixed')), 'forbidden')
      expect(calls.resolve).toEqual(['chat-mixed'])
      expect(calls.source).toEqual([])
    })

    test('the same principal still reads its own fleet', async () => {
      const { read } = harness({
        principal: scoped,
        answers: [resolved('contact-a'), resolved('contact-a')],
        mayReadConversation: (principal, chatId) => FLEET_OF_CHAT[chatId] === fleetOf(principal),
        mayReadContact: (principal, contactId) => FLEET_OF_CONTACT[contactId] === fleetOf(principal),
      })
      const result = await read(query('chat-park-1'))
      expect(result.status).toBe('confirmed')
    })
  })

  test.each([
    ['no principal (an unsigned crm_user_id is not one)', null],
    ['an empty kind', { kind: '' }],
    ['a kind that is not a string', { kind: 1 }],
    ['an object without a kind', { userId: 'user-1' }],
    ['a bare string', 'integration_admin_session'],
  ])('12. %s is `forbidden`, and nothing else is asked or read', async (_label, principal) => {
    const { read, calls } = harness({ principal, answers: [resolved('contact-a'), resolved('contact-a')] })
    expectNoData(await read(query('chat-1')), 'forbidden')
    expect(calls.mayReadConversation).toEqual([])
    expect(calls.resolve).toEqual([])
    expect(calls.source).toEqual([])
  })

  test('12b. an authority that answers anything but `true` denies', async () => {
    const { read } = harness({
      answers: [resolved('contact-a'), resolved('contact-a')],
      mayReadConversation: () => 'yes' as unknown as boolean,
    })
    expectNoData(await read(query('chat-1')), 'forbidden')
  })

  test('12c. an operator id carried in the query is rejected as an unsupported field, never used', async () => {
    const { read, calls } = harness({ answers: [] })
    await expect(read({ ...query('chat-1'), crm_user_id: 'user-1' })).rejects.toBeInstanceOf(ContactCardForConversationValidationError)
    expect(calls.resolve).toEqual([])
  })

  test('12d. without a principal even a malformed query learns nothing', async () => {
    const { read } = harness({ principal: null })
    expectNoData(await read({ contract: 'nope' }), 'forbidden')
  })
})

describe('ContactCardForConversationQuery.v1 — association races', () => {
  test('10. stale association: the Contact was merged away between the two resolutions → `refused`, neither person is returned', async () => {
    const { read, calls } = harness({ answers: [resolved('contact-a'), resolved('contact-c')] })
    expectNoData(await read(query('chat-1')), 'refused')
    expect(calls.source).toEqual(['contact-a'])
  })

  test('11. the conversation was relinked to another person during the read → `refused`, nothing read is returned', async () => {
    const { read, calls } = harness({ answers: [resolved('contact-a'), resolved('contact-b')] })
    expectNoData(await read(query('chat-1')), 'refused')
    expect(calls.source).toEqual(['contact-a'])
  })

  test.each([
    ['unlinked', status('unresolved')],
    ['ambiguous', status('ambiguous')],
    ['deleted', status('not_found')],
    ['not exact', { status: 'resolved' }],
  ])('11b. the conversation became %s during the read → `refused`', async (_label, second) => {
    const { read } = harness({ answers: [resolved('contact-a'), second] })
    expectNoData(await read(query('chat-1')), 'refused')
  })

  test('11c. a relink and relink back during the read returns only the first Contact, which is the current one', async () => {
    const { read, calls } = harness({ answers: [resolved('contact-a'), resolved('contact-a')] })
    const result = await read(query('chat-1'))
    expect(result.status).toBe('confirmed')
    expect(calls.source).toEqual(['contact-a'])
    expect(JSON.stringify(result)).not.toContain('CONTACT-B')
  })

  test('the second resolution happens after the Contact read, not before', async () => {
    const order: string[] = []
    const answers = [resolved('contact-a'), resolved('contact-a')]
    const read = createContactCardForConversationHandlerV1({
      authority: { currentPrincipal: async () => ADMIN, mayReadConversation: async () => true, mayReadContact: async () => true },
      async resolveConversation() { order.push('resolve'); return answers.shift() },
      cardSource: { async findContactCardSource(id) { order.push(`read:${id}`); return PEOPLE['contact-a'] } },
    })
    await read(query('chat-1'))
    expect(order).toEqual(['resolve', 'read:contact-a', 'resolve'])
  })
})

describe('ContactCardForConversationQuery.v1 — no identity fallback and no writes', () => {
  test('13. the only Contact ever read is the one RCQ1 named; no phone, name or provider lookup exists on the port', async () => {
    const { read, calls } = harness({ answers: [resolved('contact-a'), resolved('contact-a')] })
    await read(query('chat-1'))
    expect(calls.source).toEqual(['contact-a'])
  })

  test('13b. a padded Chat.id is a contract error, never trimmed into another conversation', async () => {
    const { read, calls } = harness({ answers: [] })
    await expect(read(query(' chat-1'))).rejects.toBeInstanceOf(ContactCardForConversationValidationError)
    await expect(read(query('chat-1 '))).rejects.toBeInstanceOf(ContactCardForConversationValidationError)
    expect(calls.resolve).toEqual([])
  })

  test.each([
    ['an empty Chat.id', query('')],
    ['a missing Chat.id', { contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1 }],
    ['a Contact id instead', { contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, contactId: 'contact-a' }],
    ['a phone instead', { contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId: 'chat-1', phone: '79990000001' }],
    ['another contract', { contract: 'contacts.ContactLookup.v1', chatId: 'chat-1' }],
  ])('13c. %s is a contract error and reads nothing', async (_label, input) => {
    const { read, calls } = harness({ answers: [] })
    await expect(read(input)).rejects.toBeInstanceOf(ContactCardForConversationValidationError)
    expect(calls.resolve).toEqual([])
    expect(calls.source).toEqual([])
  })

  test('14. the handler holds read ports only: the source port has exactly one read method', async () => {
    const port = { async findContactCardSource() { return PEOPLE['contact-a'] } }
    expect(Object.keys(port)).toEqual(['findContactCardSource'])
    const read = createContactCardForConversationHandlerV1({
      authority: { currentPrincipal: async () => ADMIN, mayReadConversation: async () => true, mayReadContact: async () => true },
      resolveConversation: async () => resolved('contact-a'),
      cardSource: Object.freeze(port),
    })
    expect((await read(query('chat-1'))).status).toBe('confirmed')
  })

  test('a failing port fails the read instead of answering with partial data', async () => {
    const read = createContactCardForConversationHandlerV1({
      authority: { currentPrincipal: async () => ADMIN, mayReadConversation: async () => true, mayReadContact: async () => true },
      resolveConversation: async () => resolved('contact-a'),
      cardSource: { async findContactCardSource() { throw new Error('database unavailable') } },
    })
    await expect(read(query('chat-1'))).rejects.toThrow('database unavailable')
  })
})

describe('buildContactCardV1 — projection', () => {
  test('no provider id can become the name: identities reach the display policy without external ids', () => {
    const card = buildContactCardV1(person('contact-a', {
      displayName: null,
      phones: [],
      primaryPhoneId: null,
      identities: [{ id: 'identity-1', channel: 'telegram', isActive: true, metadata: {}, displayName: null }],
    }))
    expect(card.displayName).toBe('Контакт')
    expect(card.primaryPhone).toBeNull()
  })

  test('a technical provider display name is not used as the name', () => {
    const card = buildContactCardV1(person('contact-a', {
      displayName: 'Контакт TG',
      identities: [{ id: 'identity-1', channel: 'telegram', isActive: true, metadata: {}, displayName: 'telegram:123456789' }],
    }))
    expect(card.displayName).toBe(formatContactPhone('79990000001'))
  })

  test('a confirmed person name from Contacts evidence becomes the name; without it the Contact name stays', () => {
    expect(buildContactCardV1(person('contact-a', { confirmedPersonName: 'Иван Петров' })).displayName).toBe('Иван Петров')
    expect(buildContactCardV1(person('contact-a')).displayName).toBe('CONTACT-A-NAME-SENTINEL')
  })

  test('a manual name outranks the confirmed person name, as ContactDisplayPolicy decides', () => {
    const card = buildContactCardV1(person('contact-a', { displayNameSource: 'manual', displayName: 'Ручное имя', confirmedPersonName: 'Иван Петров' }))
    expect(card.displayName).toBe('Ручное имя')
  })

  test('an open journal entry on an identity flags its channel and the Contact', () => {
    const card = buildContactCardV1(person('contact-a', {
      customFields: { identityConflicts: [{ status: 'open', identityId: 'contact-a-identity-tg', conflictType: 'channel_identity_collision' }] },
    }))
    expect(card.channels).toEqual([{ channel: 'telegram', identityCount: 1, hasActiveIdentity: true, hasOpenIdentityConflict: true }])
    expect(card.hasOpenIdentityConflict).toBe(true)
  })

  test('the identity latch alone flags its channel and the Contact (both conflict stores are read)', () => {
    const card = buildContactCardV1(person('contact-a', {
      identities: [{ id: 'identity-1', channel: 'max', isActive: true, metadata: { conflictState: 'conflicted' }, displayName: null }],
    }))
    expect(card.channels[0].hasOpenIdentityConflict).toBe(true)
    expect(card.hasOpenIdentityConflict).toBe(true)
  })

  test('an open entry naming an identity the Contact no longer has still flags the Contact, but no channel', () => {
    const card = buildContactCardV1(person('contact-a', {
      customFields: { identityConflicts: [{ status: 'open', identityId: 'identity-deleted' }] },
    }))
    expect(card.hasOpenIdentityConflict).toBe(true)
    expect(card.channels.every(channel => !channel.hasOpenIdentityConflict)).toBe(true)
  })

  test('an entry whose status is not exactly `open` does not count, as in every runtime reader', () => {
    for (const statusValue of ['resolved', 'OPEN', 'unknown', undefined]) {
      const card = buildContactCardV1(person('contact-a', {
        customFields: { identityConflicts: [{ status: statusValue, identityId: 'contact-a-identity-tg' }] },
      }))
      expect(card.hasOpenIdentityConflict).toBe(false)
    }
  })

  test('channels are grouped, counted and listed in code-point order; inactive and removed phones are not counted', () => {
    const card = buildContactCardV1(person('contact-a', {
      phones: [
        { id: 'p1', phone: '79990000001', isActive: true, lifecycle: 'current' },
        { id: 'p2', phone: '79990000004', isActive: false, lifecycle: 'removed' },
        { id: 'p3', phone: '79990000005', isActive: true, lifecycle: 'removed' },
        { id: 'p4', phone: '79990000006', isActive: true, lifecycle: 'superseded' },
      ],
      primaryPhoneId: 'p1',
      identities: [
        { id: 'i1', channel: 'whatsapp', isActive: false, metadata: {}, displayName: null },
        { id: 'i2', channel: 'max', isActive: true, metadata: {}, displayName: null },
        { id: 'i3', channel: 'whatsapp', isActive: true, metadata: {}, displayName: null },
        { id: 'i4', channel: 'Telegram', isActive: false, metadata: {}, displayName: null },
      ],
    }))
    expect(card.phoneCount).toBe(2)
    expect(card.channels).toEqual([
      { channel: 'Telegram', identityCount: 1, hasActiveIdentity: false, hasOpenIdentityConflict: false },
      { channel: 'max', identityCount: 1, hasActiveIdentity: true, hasOpenIdentityConflict: false },
      { channel: 'whatsapp', identityCount: 2, hasActiveIdentity: true, hasOpenIdentityConflict: false },
    ])
  })

  test('the merge count is a non-negative integer', () => {
    expect(buildContactCardV1(person('contact-a', { mergedFromCount: 3 })).mergedFromCount).toBe(3)
    expect(buildContactCardV1(person('contact-a', { mergedFromCount: -2 })).mergedFromCount).toBe(0)
    expect(buildContactCardV1(person('contact-a', { mergedFromCount: Number.NaN })).mergedFromCount).toBe(0)
  })
})

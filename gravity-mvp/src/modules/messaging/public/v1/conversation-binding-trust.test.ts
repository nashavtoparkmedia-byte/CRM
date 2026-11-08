import { describe, expect, it, vi } from 'vitest'
import {
  CONVERSATION_BINDING_AUDIT_QUERY_V1,
  CONVERSATION_BINDING_AUDIT_RESULT_V1,
  ConversationBindingAuditQueryValidationError,
  parseConversationBindingAuditQueryV1,
} from '../../../../contracts/messaging/v1'
import {
  conversationPersonBindingStateV1,
  conversationPersonGroupKeyV1,
  isConversationPersonTrustedV1,
  telegramConversationPeerV1,
  type ConversationBindingFactsV1,
} from './conversation-binding-trust-policy'
import { createConversationBindingAuditHandlerV1, type AuditedConversationV1, type ConversationBindingAuditPortV1 } from './conversation-binding-audit-handler'

function telegram(overrides: Partial<ConversationBindingFactsV1> = {}): ConversationBindingFactsV1 {
  return {
    channel: 'telegram',
    chatType: 'private',
    externalChatId: 'telegram:4242',
    contactId: 'contact-a',
    contactIdentityId: 'identity-a',
    linkedIdentity: { id: 'identity-a', channel: 'telegram', externalId: '4242', contactId: 'contact-a', isActive: true },
    ...overrides,
  }
}

describe('conversation binding trust policy', () => {
  it('reads the numeric peer of a private Telegram conversation only', () => {
    expect(telegramConversationPeerV1(telegram())).toBe('4242')
    expect(telegramConversationPeerV1(telegram({ chatType: undefined }))).toBe('4242')
    expect(telegramConversationPeerV1(telegram({ chatType: 'group' }))).toBeNull()
    expect(telegramConversationPeerV1(telegram({ externalChatId: 'telegram:group:-100' }))).toBeNull()
    expect(telegramConversationPeerV1(telegram({ externalChatId: 'telegram:@name' }))).toBeNull()
    expect(telegramConversationPeerV1(telegram({ channel: 'max', externalChatId: 'telegram:4242' }))).toBeNull()
  })

  it('a conversation linked to its own Telegram peer is consistent', () => {
    expect(conversationPersonBindingStateV1(telegram())).toBe('consistent')
  })

  it('a numeric Telegram identity naming another peer contradicts the binding', () => {
    expect(conversationPersonBindingStateV1(telegram({
      linkedIdentity: { id: 'identity-a', channel: 'telegram', externalId: '9999', contactId: 'contact-a', isActive: true },
    }))).toBe('contradicted')
  })

  it('an identity of another contact contradicts the binding, on any channel', () => {
    expect(conversationPersonBindingStateV1(telegram({
      linkedIdentity: { id: 'identity-a', channel: 'telegram', externalId: '4242', contactId: 'contact-b', isActive: true },
    }))).toBe('contradicted')
    expect(conversationPersonBindingStateV1(telegram({
      channel: 'whatsapp',
      externalChatId: '79990001122@c.us',
      linkedIdentity: { id: 'identity-a', channel: 'whatsapp', externalId: '79990001122', contactId: 'contact-b', isActive: true },
    }))).toBe('contradicted')
  })

  it('keeps every binding it cannot contradict as it is today', () => {
    expect(conversationPersonBindingStateV1(telegram({ contactIdentityId: null, linkedIdentity: null }))).toBe('unverifiable')
    expect(conversationPersonBindingStateV1(telegram({ linkedIdentity: null }))).toBe('unverifiable')
    expect(conversationPersonBindingStateV1(telegram({
      linkedIdentity: { id: 'identity-a', channel: 'telegram', externalId: '9999', contactId: 'contact-a', isActive: false },
    }))).toBe('unverifiable')
    expect(conversationPersonBindingStateV1(telegram({
      linkedIdentity: { id: 'identity-a', channel: 'telegram', externalId: 'legacy-name', contactId: 'contact-a', isActive: true },
    }))).toBe('unverifiable')
    expect(conversationPersonBindingStateV1(telegram({
      linkedIdentity: { id: 'identity-a', channel: 'whatsapp', externalId: '9999', contactId: 'contact-a', isActive: true },
    }))).toBe('unverifiable')
    expect(conversationPersonBindingStateV1(telegram({
      channel: 'max',
      externalChatId: 'max:123',
      linkedIdentity: { id: 'identity-a', channel: 'max', externalId: '456', contactId: 'contact-a', isActive: true },
    }))).toBe('unverifiable')
  })

  it('a mismatched identity id is never taken for the linked identity', () => {
    expect(conversationPersonBindingStateV1(telegram({
      linkedIdentity: { id: 'identity-x', channel: 'telegram', externalId: '9999', contactId: 'contact-b', isActive: true },
    }))).toBe('unverifiable')
  })

  it('a conversation without a contact is unbound, whatever driver it carries', () => {
    expect(conversationPersonBindingStateV1(telegram({ contactId: null, contactIdentityId: null, linkedIdentity: null }))).toBe('unbound')
  })

  it('groups by contact only, and never a group, an unbound or a contradicted conversation', () => {
    expect(conversationPersonGroupKeyV1(telegram())).toBe('c:contact-a')
    expect(conversationPersonGroupKeyV1(telegram({ contactIdentityId: null, linkedIdentity: null }))).toBe('c:contact-a')
    expect(conversationPersonGroupKeyV1(telegram({ chatType: 'group' }))).toBeNull()
    expect(conversationPersonGroupKeyV1(telegram({ contactId: null, contactIdentityId: null, linkedIdentity: null }))).toBeNull()
    expect(conversationPersonGroupKeyV1(telegram({
      linkedIdentity: { id: 'identity-a', channel: 'telegram', externalId: '9999', contactId: 'contact-a', isActive: true },
    }))).toBeNull()
    expect(isConversationPersonTrustedV1('consistent')).toBe(true)
    expect(isConversationPersonTrustedV1('unverifiable')).toBe(true)
    expect(isConversationPersonTrustedV1('contradicted')).toBe(false)
    expect(isConversationPersonTrustedV1('unbound')).toBe(false)
  })
})

describe('conversation binding audit', () => {
  it('parses its query strictly', () => {
    expect(parseConversationBindingAuditQueryV1({ contract: CONVERSATION_BINDING_AUDIT_QUERY_V1 })).toEqual({ contract: CONVERSATION_BINDING_AUDIT_QUERY_V1 })
    expect(parseConversationBindingAuditQueryV1({ contract: CONVERSATION_BINDING_AUDIT_QUERY_V1, limit: 500, afterChatId: 'c1' })).toMatchObject({ limit: 500, afterChatId: 'c1' })
    for (const bad of [
      null,
      { contract: CONVERSATION_BINDING_AUDIT_QUERY_V1, limit: 0 },
      { contract: CONVERSATION_BINDING_AUDIT_QUERY_V1, limit: 501 },
      { contract: CONVERSATION_BINDING_AUDIT_QUERY_V1, afterChatId: '' },
      { contract: CONVERSATION_BINDING_AUDIT_QUERY_V1, write: true },
      { contract: 'messaging.ContactConversationsQuery.v1' },
    ]) {
      expect(() => parseConversationBindingAuditQueryV1(bad)).toThrow(ConversationBindingAuditQueryValidationError)
    }
    expect(() => parseConversationBindingAuditQueryV1({ contract: 'messaging.ConversationBindingAuditQuery.v2' })).toThrow(/unsupported contract version/)
  })

  it('counts states and Contacts answers, samples ids only, and pages by id', async () => {
    const page: AuditedConversationV1[] = [
      { id: 'c1', ...telegram() },
      { id: 'c2', ...telegram({ linkedIdentity: { id: 'identity-a', channel: 'telegram', externalId: '9999', contactId: 'contact-a', isActive: true } }) },
      { id: 'c3', ...telegram({ contactIdentityId: null, linkedIdentity: null }) },
    ]
    const port: ConversationBindingAuditPortV1 = {
      listBoundTelegramConversations: vi.fn(async () => page),
      resolvePeer: vi.fn(async (): Promise<'ready' | 'peer_identity_not_found'> => 'ready'),
    }
    vi.mocked(port.resolvePeer).mockResolvedValueOnce('ready').mockResolvedValueOnce('peer_identity_not_found')

    const result = await createConversationBindingAuditHandlerV1(port)({ contract: CONVERSATION_BINDING_AUDIT_QUERY_V1, limit: 3 })

    expect(port.listBoundTelegramConversations).toHaveBeenCalledWith({ afterChatId: null, limit: 3 })
    expect(port.resolvePeer).toHaveBeenCalledTimes(2)
    expect(port.resolvePeer).toHaveBeenNthCalledWith(1, { contactId: 'contact-a', peerExternalId: '4242', linkedIdentityId: 'identity-a' })
    expect(result).toEqual({
      contract: CONVERSATION_BINDING_AUDIT_RESULT_V1,
      checked: 3,
      states: { consistent: 1, unverifiable: 1, contradicted: 1 },
      peer: { ready: 1, contact_not_found: 0, peer_identity_not_found: 1, peer_identity_conflicted: 0, linked_identity_not_found: 0, not_asked: 1 },
      contradictedChatIds: ['c2'],
      peerNotOfContactChatIds: ['c2'],
      nextAfterChatId: 'c3',
    })
  })

  it('ends paging on a short page and refuses an unbound row', async () => {
    const short = createConversationBindingAuditHandlerV1({
      listBoundTelegramConversations: vi.fn(async () => [{ id: 'c1', ...telegram() }]),
      resolvePeer: vi.fn(async () => 'ready' as const),
    })
    expect((await short({ contract: CONVERSATION_BINDING_AUDIT_QUERY_V1, limit: 5 })).nextAfterChatId).toBeNull()

    const broken = createConversationBindingAuditHandlerV1({
      listBoundTelegramConversations: vi.fn(async () => [{ id: 'c1', ...telegram({ contactId: null, contactIdentityId: null, linkedIdentity: null }) }]),
      resolvePeer: vi.fn(async () => 'ready' as const),
    })
    await expect(broken({ contract: CONVERSATION_BINDING_AUDIT_QUERY_V1 })).rejects.toThrow('CONVERSATION_BINDING_AUDIT_UNBOUND_ROW')
  })
})

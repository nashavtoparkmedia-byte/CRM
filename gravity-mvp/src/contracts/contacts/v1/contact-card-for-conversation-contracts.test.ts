import { describe, expect, test } from 'vitest'

import {
  CONTACT_CARD_FOR_CONVERSATION_QUERY_V1,
  ContactCardForConversationValidationError,
  parseContactCardForConversationQueryV1,
} from './contact-card-for-conversation-contracts'

function codeOf(input: unknown): string | null {
  try {
    parseContactCardForConversationQueryV1(input)
    return null
  } catch (error) {
    if (error instanceof ContactCardForConversationValidationError) return error.code
    throw error
  }
}

describe('ContactCardForConversationQuery.v1 contract', () => {
  test('accepts exactly a contract and an exact Chat.id, unchanged', () => {
    expect(parseContactCardForConversationQueryV1({ contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId: 'cm-chat-1' }))
      .toEqual({ contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId: 'cm-chat-1' })
  })

  test.each([
    ['not an object', 'chat-1'],
    ['null', null],
    ['an array', [CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, 'chat-1']],
    ['no contract', { chatId: 'chat-1' }],
    ['another contract', { contract: 'messaging.ResolveConversationContactQuery.v1', chatId: 'chat-1' }],
    ['no Chat.id', { contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1 }],
    ['an empty Chat.id', { contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId: '' }],
    ['a blank Chat.id', { contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId: '   ' }],
    ['a padded Chat.id', { contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId: ' chat-1' }],
    ['a numeric Chat.id', { contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId: 1 }],
    ['a Contact id beside it', { contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId: 'chat-1', contactId: 'contact-a' }],
    ['an operator id beside it', { contract: CONTACT_CARD_FOR_CONVERSATION_QUERY_V1, chatId: 'chat-1', crm_user_id: 'user-1' }],
  ])('rejects %s as INVALID_CONTRACT', (_label, input) => {
    expect(codeOf(input)).toBe('INVALID_CONTRACT')
  })

  test('names a newer version of the same query as UNSUPPORTED_CONTRACT_VERSION', () => {
    expect(codeOf({ contract: 'contacts.ContactCardForConversationQuery.v2', chatId: 'chat-1' })).toBe('UNSUPPORTED_CONTRACT_VERSION')
  })
})

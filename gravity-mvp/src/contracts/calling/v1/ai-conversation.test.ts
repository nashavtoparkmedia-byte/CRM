import { describe, expect, it } from 'vitest'
import {
  AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1,
  AI_CONVERSATION_TERMINAL_STATES_V1,
  AiConversationContractValidationError,
  START_AI_CONVERSATION_COMMAND_V1,
  isTerminalAiConversationStateV1,
  parseAiConversationsForContactQueryV1,
  parseStartAiConversationCommandV1,
} from './ai-conversation'

const valid = { contract: START_AI_CONVERSATION_COMMAND_V1, requestId: 'pc_0123456789abcdef', contactId: 'contact-1' }

describe('calling.StartAiConversationCommand.v1', () => {
  it('accepts exactly a Contact id, an opaque request id and an optional simulation variant', () => {
    expect(parseStartAiConversationCommandV1(valid)).toEqual(valid)
    expect(parseStartAiConversationCommandV1({ ...valid, simulationVariant: 'unknown_outcome' })).toMatchObject({ simulationVariant: 'unknown_outcome' })
  })

  it.each([
    ['a phone number', { ...valid, phone: '+79990000000' }],
    ['a provider', { ...valid, provider: 'freeswitch' }],
    ['a short request id', { ...valid, requestId: 'abc' }],
    ['a request id with spaces', { ...valid, requestId: 'pc_0123456789 abcdef' }],
    ['an untrimmed contact id', { ...valid, contactId: ' contact-1' }],
    ['an empty contact id', { ...valid, contactId: '' }],
    ['an unknown variant', { ...valid, simulationVariant: 'live' }],
    ['a foreign contract', { ...valid, contract: 'calling.SomethingElse.v1' }],
  ])('rejects %s', (_name, input) => {
    expect(() => parseStartAiConversationCommandV1(input)).toThrow(AiConversationContractValidationError)
  })

  it('names an unsupported version as such', () => {
    try {
      parseStartAiConversationCommandV1({ ...valid, contract: 'calling.StartAiConversationCommand.v2' })
      throw new Error('accepted')
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSUPPORTED_CONTRACT_VERSION' })
    }
  })
})

describe('calling.AiConversationsForContactQuery.v1', () => {
  it('accepts only the exact Contact id', () => {
    expect(parseAiConversationsForContactQueryV1({ contract: AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, contactId: 'contact-1' }))
      .toEqual({ contract: AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, contactId: 'contact-1' })
    expect(() => parseAiConversationsForContactQueryV1({ contract: AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, contactId: 'contact-1', limit: 500 }))
      .toThrow(AiConversationContractValidationError)
  })

  it('treats exactly the terminal states as terminal', () => {
    expect(AI_CONVERSATION_TERMINAL_STATES_V1).toEqual(['completed', 'interrupted', 'failed', 'outcome_unknown', 'refused'])
    expect(isTerminalAiConversationStateV1('in_conversation')).toBe(false)
    expect(isTerminalAiConversationStateV1('outcome_unknown')).toBe(true)
  })
})

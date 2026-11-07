import { describe, expect, it } from 'vitest'
import {
  SEND_TO_CONTACT_CHANNELS_V1,
  SEND_TO_CONTACT_COMMAND_V1,
  SendToContactValidationError,
  parseSendToContactCommandV1,
} from './send-to-contact-command'

const valid = {
  contract: SEND_TO_CONTACT_COMMAND_V1,
  requestId: 'comm-run:42.step-1_a',
  contactId: 'contact-1',
  content: 'Здравствуйте! 👋',
}

function rejection(input: unknown): SendToContactValidationError {
  try {
    parseSendToContactCommandV1(input)
  } catch (error) {
    expect(error).toBeInstanceOf(SendToContactValidationError)
    return error as SendToContactValidationError
  }
  throw new Error('expected the command to be rejected')
}

const expectInvalid = (input: unknown) => expect(rejection(input).code).toBe('INVALID_CONTRACT')

describe('parseSendToContactCommandV1', () => {
  it('accepts the minimal command and returns a fresh object with no allowedChannels key', () => {
    const parsed = parseSendToContactCommandV1(valid)
    expect(parsed).toEqual(valid)
    expect(parsed).not.toBe(valid)
    expect('allowedChannels' in parsed).toBe(false)
  })

  it('treats an explicitly undefined allowedChannels as absent', () => {
    const parsed = parseSendToContactCommandV1({ ...valid, allowedChannels: undefined })
    expect('allowedChannels' in parsed).toBe(false)
  })

  it('keeps allowedChannels exactly as supplied, order included, in a copy', () => {
    const allowedChannels = ['max', 'telegram']
    const parsed = parseSendToContactCommandV1({ ...valid, allowedChannels })
    expect(parsed.allowedChannels).toEqual(['max', 'telegram'])
    expect(parsed.allowedChannels).not.toBe(allowedChannels)
    allowedChannels.push('whatsapp')
    expect(parsed.allowedChannels).toEqual(['max', 'telegram'])
  })

  it('declares exactly the three sendable channels', () => {
    expect([...SEND_TO_CONTACT_CHANNELS_V1]).toEqual(['telegram', 'whatsapp', 'max'])
  })

  it('rejects a non-object and every unknown field, route fields included', () => {
    for (const input of [null, undefined, 'x', 1, [], [valid]]) expectInvalid(input)
    for (const field of ['chatId', 'conversationId', 'channel', 'phone', 'identityId', 'connectionId', 'providerAccountId', 'target', 'actor', 'projectId', 'semanticPayloadSha256']) {
      expect(rejection({ ...valid, [field]: 'x' }).message).toContain(field)
    }
  })

  it('separates an unsupported version from a foreign contract', () => {
    expect(rejection({ ...valid, contract: 'messaging.SendToContactCommand.v2' }).code).toBe('UNSUPPORTED_CONTRACT_VERSION')
    expectInvalid({ ...valid, contract: 'messaging.SendMessageCommand.v1' })
    expectInvalid({ ...valid, contract: undefined })
  })

  it('bounds the requestId to 1..128 characters of [A-Za-z0-9._:-], starting with a letter or digit', () => {
    expect(parseSendToContactCommandV1({ ...valid, requestId: 'a'.repeat(128) }).requestId).toHaveLength(128)
    expect(parseSendToContactCommandV1({ ...valid, requestId: '7' }).requestId).toBe('7')
    for (const requestId of ['', 'a'.repeat(129), '-a', '.a', ':a', 'a b', 'a/b', 'é', 'a\n', 1, null]) {
      expectInvalid({ ...valid, requestId })
    }
  })

  it('bounds the contactId and refuses surrounding whitespace, control characters and unpaired surrogates', () => {
    expect(parseSendToContactCommandV1({ ...valid, contactId: 'c'.repeat(128) }).contactId).toHaveLength(128)
    for (const contactId of ['', 'c'.repeat(129), ' contact', 'contact ', '\tcontact', 'con\u0000tact', 'con\u007Ftact', 'con\u0085tact', 'con\uD800tact', 1, null]) {
      expectInvalid({ ...valid, contactId })
    }
  })

  it('keeps content byte-exact: no trim, no Unicode normalisation', () => {
    for (const content of ['  padded  ', '\nline\n', 'é', 'é', 'tab\there', '👋'.repeat(2048)]) {
      expect(parseSendToContactCommandV1({ ...valid, content }).content).toBe(content)
    }
  })

  it('bounds content to 1..4096 UTF-16 code units with a non-whitespace character, no NUL, well-formed', () => {
    expect(parseSendToContactCommandV1({ ...valid, content: 'x'.repeat(4096) }).content).toHaveLength(4096)
    for (const content of ['', 'x'.repeat(4097), '👋'.repeat(2049), ' ', '\n\t', '  ', 'a\u0000b', 'a\uD800', '\uDC00a', 1, null]) {
      expectInvalid({ ...valid, content })
    }
  })

  it('rejects an empty, duplicated, non-array or unknown channel narrowing instead of normalising it', () => {
    for (const allowedChannels of [[], ['telegram', 'telegram'], ['phone'], ['avito'], ['TELEGRAM'], ['telegram', 1], 'telegram', null, {}]) {
      expectInvalid({ ...valid, allowedChannels })
    }
  })

  it('accepts frozen input without mutating it', () => {
    const input = Object.freeze({ ...valid, allowedChannels: Object.freeze(['whatsapp']) })
    expect(parseSendToContactCommandV1(input).allowedChannels).toEqual(['whatsapp'])
  })
})

export const CONTACT_CONVERSATION_CHANNELS_V1 = ['telegram', 'whatsapp', 'max'] as const
export type ContactConversationChannelV1 = typeof CONTACT_CONVERSATION_CHANNELS_V1[number]
export type ContactConversationStoredChannelV1 = ContactConversationChannelV1 | 'phone' | 'avito'

export interface ContactConversationV1 {
  id: string
  channel: ContactConversationStoredChannelV1
  externalChatId: string
  status: string
  contactId: string | null
  contactIdentityId: string | null
}

export const FIND_AND_BACKFILL_CONTACT_CONVERSATION_COMMAND_V1 =
  'messaging.FindAndBackfillContactConversationCommand.v1' as const
export const FIND_AND_BACKFILL_CONTACT_CONVERSATION_RESULT_V1 =
  'messaging.FindAndBackfillContactConversationResult.v1' as const
export const OPEN_FALLBACK_CONTACT_CONVERSATION_COMMAND_V1 =
  'messaging.OpenFallbackContactConversationCommand.v1' as const
export const OPEN_FALLBACK_CONTACT_CONVERSATION_RESULT_V1 =
  'messaging.OpenFallbackContactConversationResult.v1' as const

export interface FindAndBackfillContactConversationCommandV1 {
  contract: typeof FIND_AND_BACKFILL_CONTACT_CONVERSATION_COMMAND_V1
  contactId: string
  contactIdentityId: string
  channel: ContactConversationChannelV1
  allowContactFallback: boolean
}

export interface FindAndBackfillContactConversationResultV1 {
  contract: typeof FIND_AND_BACKFILL_CONTACT_CONVERSATION_RESULT_V1
  conversation: ContactConversationV1 | null
}

export interface OpenFallbackContactConversationCommandV1 {
  contract: typeof OPEN_FALLBACK_CONTACT_CONVERSATION_COMMAND_V1
  legacyDriverId: string | null
  channel: ContactConversationChannelV1
  externalChatId: string
  name: string | null
  contactId: string
  contactIdentityId: string
}

export interface OpenFallbackContactConversationResultV1 {
  contract: typeof OPEN_FALLBACK_CONTACT_CONVERSATION_RESULT_V1
  conversation: ContactConversationV1
  isNew: boolean
}

export class ContactConversationCommandValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(
    code: ContactConversationCommandValidationError['code'],
    message: string,
  ) {
    super(message)
    this.name = 'ContactConversationCommandValidationError'
    this.code = code
  }
}

const CHANNELS = new Set<string>(CONTACT_CONVERSATION_CHANNELS_V1)

function invalid(message: string): never {
  throw new ContactConversationCommandValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEnvelope(
  input: unknown,
  expectedContract: string,
  versionPrefix: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (!isRecord(input)) invalid('command must be an object')
  const extraFields = Object.keys(input).filter((key) => !fields.includes(key))
  if (extraFields.length > 0) {
    invalid(`unsupported field(s): ${extraFields.sort().join(', ')}`)
  }
  if (input.contract !== expectedContract) {
    if (typeof input.contract === 'string' && input.contract.startsWith(versionPrefix)) {
      throw new ContactConversationCommandValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${expectedContract}`)
  }
  return input
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${field} is required`)
}

function requireChannel(value: unknown): void {
  if (typeof value !== 'string' || !CHANNELS.has(value)) invalid('channel is invalid')
}

export function parseFindAndBackfillContactConversationCommandV1(
  input: unknown,
): FindAndBackfillContactConversationCommandV1 {
  const value = parseEnvelope(
    input,
    FIND_AND_BACKFILL_CONTACT_CONVERSATION_COMMAND_V1,
    'messaging.FindAndBackfillContactConversationCommand.',
    ['contract', 'contactId', 'contactIdentityId', 'channel', 'allowContactFallback'],
  )
  requireString(value.contactId, 'contactId')
  requireString(value.contactIdentityId, 'contactIdentityId')
  requireChannel(value.channel)
  if (typeof value.allowContactFallback !== 'boolean') invalid('allowContactFallback must be a boolean')
  return value as unknown as FindAndBackfillContactConversationCommandV1
}

export function parseOpenFallbackContactConversationCommandV1(
  input: unknown,
): OpenFallbackContactConversationCommandV1 {
  const value = parseEnvelope(
    input,
    OPEN_FALLBACK_CONTACT_CONVERSATION_COMMAND_V1,
    'messaging.OpenFallbackContactConversationCommand.',
    [
      'contract',
      'legacyDriverId',
      'channel',
      'externalChatId',
      'name',
      'contactId',
      'contactIdentityId',
    ],
  )
  if (value.legacyDriverId !== null) requireString(value.legacyDriverId, 'legacyDriverId')
  requireChannel(value.channel)
  requireString(value.externalChatId, 'externalChatId')
  if (value.name !== null && typeof value.name !== 'string') invalid('name must be a string or null')
  requireString(value.contactId, 'contactId')
  requireString(value.contactIdentityId, 'contactIdentityId')
  return value as unknown as OpenFallbackContactConversationCommandV1
}

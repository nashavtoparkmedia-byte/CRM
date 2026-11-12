// Calling-owned public contract for a manually started AI conversation (C4).
//
// The smallest surface that lets a CRM screen start one AI conversation with a
// Contact and read back its lifecycle, transcript and structured outcome. It
// names a Contact and an opaque request identity, never a phone number, a
// provider, a scenario implementation or a telephony channel: the destination
// is resolved server-side from Contacts, and the provider is behind Calling's
// own port. Only manual initiation exists in V1; campaigns keep their own
// contracts.

export const START_AI_CONVERSATION_COMMAND_V1 = 'calling.StartAiConversationCommand.v1' as const
export const START_AI_CONVERSATION_RESULT_V1 = 'calling.StartAiConversationResult.v1' as const
export const AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1 = 'calling.AiConversationsForContactQuery.v1' as const
export const AI_CONVERSATIONS_FOR_CONTACT_RESULT_V1 = 'calling.AiConversationsForContactResult.v1' as const

/** Opaque, client-generated per start intent; the same id replays the same conversation. */
export const AI_CONVERSATION_REQUEST_ID_PATTERN_V1 = /^[A-Za-z0-9_-]{16,128}$/u
export const AI_CONVERSATION_CONTACT_ID_MAX_LENGTH_V1 = 128
export const AI_CONVERSATION_LIST_LIMIT_V1 = 20

/**
 * Only meaningful while the runtime is simulated: which scripted conversation
 * the simulator plays. A live runtime would refuse the field.
 */
export const AI_CONVERSATION_SIMULATION_VARIANTS_V1 = ['success', 'provider_failure', 'interrupted', 'unknown_outcome'] as const
export type AiConversationSimulationVariantV1 = typeof AI_CONVERSATION_SIMULATION_VARIANTS_V1[number]

export type StartAiConversationCommandV1 = {
  contract: typeof START_AI_CONVERSATION_COMMAND_V1
  requestId: string
  contactId: string
  simulationVariant?: AiConversationSimulationVariantV1
}

export type AiConversationRuntimeModeV1 = 'simulated' | 'disabled'

export type AiConversationStateV1 =
  | 'queued'
  | 'dialing'
  | 'ringing'
  | 'in_conversation'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'outcome_unknown'
  | 'refused'

export const AI_CONVERSATION_TERMINAL_STATES_V1: readonly AiConversationStateV1[] = [
  'completed', 'interrupted', 'failed', 'outcome_unknown', 'refused',
]

export type AiConversationFailureCodeV1 =
  | 'voice_restricted'
  | 'voice_permission_unavailable'
  | 'provider_rejected'
  | 'provider_failed'
  | 'interrupted'
  | 'outcome_unknown'
  | 'expired'

export type AiConversationTranscriptLineV1 = {
  ordinal: number
  speaker: 'assistant' | 'person'
  text: string
}

export type AiConversationOutcomeV1 = {
  qualification: 'qualified' | 'not_qualified' | 'unclear'
  summary: string | null
  score: number | null
  /** Calling's structured outcome classification (qualified, dropped_mid_call, error, …). */
  classification: string | null
}

export type AiConversationViewV1 = {
  conversationId: string
  contactId: string
  initiation: 'manual'
  mode: 'simulated'
  state: AiConversationStateV1
  failure: AiConversationFailureCodeV1 | null
  /** The destination with all but the last four digits hidden. */
  destinationMasked: string
  startedAt: string
  answeredAt: string | null
  endedAt: string | null
  updatedAt: string
  /** While outcome_unknown: no new conversation with this person can start before this instant. */
  occupiedUntil: string | null
  transcript: AiConversationTranscriptLineV1[]
  outcome: AiConversationOutcomeV1 | null
}

export type StartAiConversationRefusalV1 =
  | 'unauthenticated'
  | 'disabled'
  /** Contacts no longer answers `confirmed` for exactly this canonical id (merged, missing, unreadable): reload the card. */
  | 'contact_changed'
  | 'identity_unconfirmed'
  | 'identity_conflict'
  | 'voice_restricted'
  | 'voice_permission_unavailable'
  /** No primary phone that is current, active and undisputed. Another phone of the card is never used instead. */
  | 'no_primary_phone'
  | 'busy'

export type StartAiConversationResultV1 =
  | {
    contract: typeof START_AI_CONVERSATION_RESULT_V1
    status: 'accepted'
    /** True when this requestId had already started this conversation: nothing new was created. */
    duplicate: boolean
    conversation: AiConversationViewV1
  }
  | {
    contract: typeof START_AI_CONVERSATION_RESULT_V1
    status: 'refused'
    reason: StartAiConversationRefusalV1
    /** A retry may succeed (an unavailable store or permission service). */
    retryable: boolean
    /** For busy: the conversation already occupying this person. */
    activeConversationId: string | null
  }

export type AiConversationsForContactQueryV1 = {
  contract: typeof AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1
  contactId: string
}

export type AiConversationsForContactResultV1 =
  | {
    contract: typeof AI_CONVERSATIONS_FOR_CONTACT_RESULT_V1
    status: 'ok'
    mode: AiConversationRuntimeModeV1
    conversations: AiConversationViewV1[]
  }
  | {
    contract: typeof AI_CONVERSATIONS_FOR_CONTACT_RESULT_V1
    /** unauthenticated: no verified principal. contact_changed: Contacts no longer confirms exactly this id. */
    status: 'unauthenticated' | 'contact_changed'
  }

export class AiConversationContractValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
  constructor(code: AiConversationContractValidationError['code'], message: string) {
    super(message)
    this.name = 'AiConversationContractValidationError'
    this.code = code
  }
}

/** The same requestId was reused for a different request (another Contact or scenario). */
export class AiConversationRequestConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiConversationRequestConflictError'
  }
}

function invalid(message: string): never {
  throw new AiConversationContractValidationError('INVALID_CONTRACT', message)
}

function record(input: unknown, expected: string, prefix: string, fields: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid('input must be an object')
  const value = input as Record<string, unknown>
  const unexpected = Object.keys(value).filter(key => !fields.includes(key))
  if (unexpected.length > 0) invalid(`unsupported field(s): ${unexpected.sort().join(', ')}`)
  if (value.contract !== expected) {
    if (typeof value.contract === 'string' && value.contract.startsWith(prefix)) {
      throw new AiConversationContractValidationError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${value.contract}`)
    }
    invalid(`contract must equal ${expected}`)
  }
  return value
}

function contactId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > AI_CONVERSATION_CONTACT_ID_MAX_LENGTH_V1 || value.trim() !== value) {
    invalid('contactId must be an exact, non-empty id')
  }
  return value
}

export function parseStartAiConversationCommandV1(input: unknown): StartAiConversationCommandV1 {
  const value = record(input, START_AI_CONVERSATION_COMMAND_V1, 'calling.StartAiConversationCommand.',
    ['contract', 'requestId', 'contactId', 'simulationVariant'])
  if (typeof value.requestId !== 'string' || !AI_CONVERSATION_REQUEST_ID_PATTERN_V1.test(value.requestId)) {
    invalid('requestId must be 16-128 characters of [A-Za-z0-9_-]')
  }
  const command: StartAiConversationCommandV1 = {
    contract: START_AI_CONVERSATION_COMMAND_V1,
    requestId: value.requestId,
    contactId: contactId(value.contactId),
  }
  if (value.simulationVariant !== undefined) {
    if (!(AI_CONVERSATION_SIMULATION_VARIANTS_V1 as readonly unknown[]).includes(value.simulationVariant)) {
      invalid('simulationVariant is not a known variant')
    }
    command.simulationVariant = value.simulationVariant as AiConversationSimulationVariantV1
  }
  return command
}

export function parseAiConversationsForContactQueryV1(input: unknown): AiConversationsForContactQueryV1 {
  const value = record(input, AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, 'calling.AiConversationsForContactQuery.',
    ['contract', 'contactId'])
  return { contract: AI_CONVERSATIONS_FOR_CONTACT_QUERY_V1, contactId: contactId(value.contactId) }
}

export function isTerminalAiConversationStateV1(state: AiConversationStateV1): boolean {
  return AI_CONVERSATION_TERMINAL_STATES_V1.includes(state)
}

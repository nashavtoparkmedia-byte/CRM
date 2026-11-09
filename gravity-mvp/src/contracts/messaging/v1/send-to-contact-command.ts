export const SEND_TO_CONTACT_COMMAND_V1 = 'messaging.SendToContactCommand.v1' as const
export const SEND_TO_CONTACT_RESULT_V1 = 'messaging.SendToContactResult.v1' as const

/** The channels SendToContact can send on. `phone` and `avito` conversations are never a route. */
export const SEND_TO_CONTACT_CHANNELS_V1 = ['telegram', 'whatsapp', 'max'] as const
export type SendToContactChannelV1 = typeof SEND_TO_CONTACT_CHANNELS_V1[number]

export const SEND_TO_CONTACT_REQUEST_ID_MAX_LENGTH_V1 = 128
export const SEND_TO_CONTACT_CONTACT_ID_MAX_LENGTH_V1 = 128
/**
 * Telegram's text limit, the strictest of the three channels, so the route
 * outcome never depends on text length. Counted in UTF-16 code units
 * (`String.length`), which is never fewer than the characters any provider counts.
 */
export const SEND_TO_CONTACT_CONTENT_MAX_LENGTH_V1 = 4096

/**
 * Send one text to a Contact through its one provable existing conversation.
 *
 * In-process only. The command names a person and a text, never a route: no
 * chat, identity, phone, provider account, transport, target, actor or business
 * concept crosses it. V1 never opens a conversation and never chooses between
 * routes; more than one provable route is refused.
 */
export interface SendToContactCommandV1 {
  contract: typeof SEND_TO_CONTACT_COMMAND_V1
  /**
   * The caller's stable id for ONE semantic send intent, permanently: the same
   * id with a different payload is an `idempotency_conflict`, whatever the
   * first answer was. 1..128 characters of `[A-Za-z0-9._:-]`, starting with a
   * letter or digit.
   */
  requestId: string
  /** 1..128 characters, no surrounding whitespace, no control character. Any merge-lineage alias is accepted. */
  contactId: string
  /**
   * The exact text, never trimmed or normalised: 1..4096 UTF-16 code units,
   * well-formed, at least one non-whitespace character, no NUL.
   */
  content: string
  /**
   * Request-scoped narrowing only, never a Contact permission and never stored
   * as one. Non-empty and duplicate-free when present; absent means no
   * narrowing, which is NOT the same request as naming every channel.
   */
  allowedChannels?: SendToContactChannelV1[]
}

/** Re-declares Messaging's seven delivery states (`DeliveryStateV1`); a contract imports no module code. */
export type SendToContactDeliveryStateV1 =
  | 'send_requested'
  | 'provider_accepted'
  | 'delivered'
  | 'read'
  | 'failed_safe_to_retry'
  | 'failed_not_safe_to_retry'
  | 'indeterminate'

export type SendToContactFailureClassV1 =
  | 'permission_refused'
  | 'provider_refused'
  | 'not_dispatched'
  | 'outcome_unknown'

/**
 * A Message exists and Messaging owns its lifecycle from here: delivery,
 * redelivery and evidence. `replayed` is true when an earlier request with this
 * requestId admitted it; the state is read from the Message now.
 */
export interface SendToContactAdmittedV1 {
  contract: typeof SEND_TO_CONTACT_RESULT_V1
  outcome: 'admitted'
  requestId: string
  replayed: boolean
  messageId: string
  channel: SendToContactChannelV1
  deliveryState: SendToContactDeliveryStateV1
  failureClass?: SendToContactFailureClassV1
}

export type SendToContactRefusalReasonV1 =
  | 'contact_unknown'
  | 'contact_archived'
  | 'contact_restricted'
  | 'permission_unavailable'
  | 'route_unavailable'
  | 'route_ambiguous'
  | 'route_evidence_incomplete'
  | 'messaging_unavailable'

/** Why no route exists. None of these is transient: the same request is refused again until something else changes. */
export type SendToContactRouteUnavailableDetailV1 =
  | 'no_conversation'
  | 'not_in_allowed_channels'
  | 'identity_not_sendable'
  | 'conversation_not_private'
  | 'transport_unbound'
  | 'transport_mismatch'
  | 'identity_binding_mismatch'
  | 'no_sendable_route'

/** Why the evidence could not prove or rule out a route. Always retryable: nothing is concluded from it. */
export type SendToContactRouteEvidenceIncompleteDetailV1 =
  | 'lineage_moved'
  | 'conversations_unavailable'
  | 'truncated'
  | 'route_proof_unavailable'

export type SendToContactRefusalDetailV1 =
  | SendToContactRouteUnavailableDetailV1
  | SendToContactRouteEvidenceIncompleteDetailV1

/**
 * No Message was created and no provider effect happened. `retryable` says
 * whether the same request may succeed later without anything else changing.
 */
export interface SendToContactRefusedV1 {
  contract: typeof SEND_TO_CONTACT_RESULT_V1
  outcome: 'refused'
  requestId: string
  retryable: boolean
  reason: SendToContactRefusalReasonV1
  /** `route_unavailable` and `route_evidence_incomplete` only. */
  detail?: SendToContactRefusalDetailV1
  /** `identity_not_sendable` only: the readiness status the identity proof reported. */
  identityStatus?: string
  /**
   * `route_ambiguous` only: the distinct channels of the provable routes found,
   * in ordinal order. The search stops at the second provable route, so this is
   * never empty but may omit a further provable channel; one entry means both
   * routes are on that channel.
   */
  candidateChannels?: SendToContactChannelV1[]
}

/** This requestId already names a different payload. Nothing was evaluated. */
export interface SendToContactIdempotencyConflictV1 {
  contract: typeof SEND_TO_CONTACT_RESULT_V1
  outcome: 'idempotency_conflict'
  requestId: string
}

export type SendToContactResultV1 =
  | SendToContactAdmittedV1
  | SendToContactRefusedV1
  | SendToContactIdempotencyConflictV1

export class SendToContactValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: SendToContactValidationError['code'], message: string) {
    super(message)
    this.name = 'SendToContactValidationError'
    this.code = code
  }
}

const SUPPORTED_FIELDS = ['contract', 'requestId', 'contactId', 'content', 'allowedChannels']
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
// C0 controls, DEL and C1 controls.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function invalid(message: string): never {
  throw new SendToContactValidationError('INVALID_CONTRACT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSendToContactChannel(value: unknown): value is SendToContactChannelV1 {
  return typeof value === 'string' && (SEND_TO_CONTACT_CHANNELS_V1 as readonly string[]).includes(value)
}

/**
 * Validates the contract, its version and every input bound, and returns a
 * fresh command. It performs no IO, so a malformed or unsupported command is
 * rejected before anything can reserve its requestId. A channel set is
 * returned exactly as supplied (order included): duplicates are rejected, never
 * folded away.
 */
export function parseSendToContactCommandV1(input: unknown): SendToContactCommandV1 {
  if (!isRecord(input)) invalid('command must be an object')

  const extraFields = Object.keys(input).filter(key => !SUPPORTED_FIELDS.includes(key))
  if (extraFields.length > 0) invalid(`unsupported field(s): ${extraFields.sort().join(', ')}`)

  if (input.contract !== SEND_TO_CONTACT_COMMAND_V1) {
    if (typeof input.contract === 'string' && input.contract.startsWith('messaging.SendToContactCommand.')) {
      throw new SendToContactValidationError(
        'UNSUPPORTED_CONTRACT_VERSION',
        `unsupported contract version: ${input.contract}`,
      )
    }
    invalid(`contract must equal ${SEND_TO_CONTACT_COMMAND_V1}`)
  }

  const { requestId, contactId, content, allowedChannels } = input

  if (typeof requestId !== 'string' || requestId.length === 0) invalid('requestId must be a non-empty string')
  if (requestId.length > SEND_TO_CONTACT_REQUEST_ID_MAX_LENGTH_V1) {
    invalid(`requestId may be at most ${SEND_TO_CONTACT_REQUEST_ID_MAX_LENGTH_V1} characters`)
  }
  if (!REQUEST_ID_PATTERN.test(requestId)) invalid('requestId may contain only [A-Za-z0-9._:-] and must start with a letter or digit')

  if (typeof contactId !== 'string' || contactId.length === 0) invalid('contactId must be a non-empty string')
  if (contactId.length > SEND_TO_CONTACT_CONTACT_ID_MAX_LENGTH_V1) {
    invalid(`contactId may be at most ${SEND_TO_CONTACT_CONTACT_ID_MAX_LENGTH_V1} characters`)
  }
  if (contactId.trim() !== contactId) invalid('contactId must not have surrounding whitespace')
  if (CONTROL_CHARACTER_PATTERN.test(contactId) || LONE_SURROGATE_PATTERN.test(contactId)) {
    invalid('contactId must not contain a control character or an unpaired surrogate')
  }

  if (typeof content !== 'string' || content.length === 0) invalid('content must be a non-empty string')
  if (content.length > SEND_TO_CONTACT_CONTENT_MAX_LENGTH_V1) {
    invalid(`content may be at most ${SEND_TO_CONTACT_CONTENT_MAX_LENGTH_V1} UTF-16 code units`)
  }
  if (content.trim() === '') invalid('content must contain a non-whitespace character')
  if (content.includes('\u0000')) invalid('content must not contain NUL')
  if (LONE_SURROGATE_PATTERN.test(content)) invalid('content must be well-formed text (no unpaired surrogate)')

  const command: SendToContactCommandV1 = { contract: SEND_TO_CONTACT_COMMAND_V1, requestId, contactId, content }
  if (allowedChannels === undefined) return command

  if (!Array.isArray(allowedChannels)) invalid('allowedChannels must be an array when present')
  if (allowedChannels.length === 0) invalid('allowedChannels must name at least one channel when present')
  const seen = new Set<string>()
  for (const channel of allowedChannels) {
    if (!isSendToContactChannel(channel)) {
      invalid(`allowedChannels may contain only ${SEND_TO_CONTACT_CHANNELS_V1.join(', ')}`)
    }
    if (seen.has(channel)) invalid(`duplicate allowedChannels entry: ${channel}`)
    seen.add(channel)
  }
  return { ...command, allowedChannels: [...allowedChannels] as SendToContactChannelV1[] }
}

// Contact communication restrictions foundation (Contact Identity epic).
//
// Two Contacts-owned contracts: a provider-neutral, fail-closed permission read
// and the Contacts-owned mutation of the standing restriction flags. Neither
// names a channel, a provider, a ProviderAccount, a Transport or a conversation:
// the only identifiers are the Contact id and an effect class.

export const CONTACT_COMMUNICATION_PERMISSION_QUERY_V1 = 'contacts.ContactCommunicationPermissionQuery.v1' as const
export const CONTACT_COMMUNICATION_PERMISSION_RESULT_V1 = 'contacts.ContactCommunicationPermissionResult.v1' as const
export const SET_CONTACT_COMMUNICATION_POLICY_COMMAND_V1 = 'contacts.SetContactCommunicationPolicyCommand.v1' as const
export const SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1 = 'contacts.SetContactCommunicationPolicyResult.v1' as const

/** The V1 effect classes. A string outside this list is denied, never guessed. */
export const CONTACT_COMMUNICATION_CLASSES_V1 = ['message', 'voice'] as const
export type ContactCommunicationClassV1 = typeof CONTACT_COMMUNICATION_CLASSES_V1[number]

/** The exact standing restriction state. V1 persists these three flags and nothing else. */
export type ContactCommunicationRestrictionStateV1 = {
  denyAll: boolean
  denyMessage: boolean
  denyVoice: boolean
}

export const CONTACT_COMMUNICATION_REQUEST_ID_MAX_LENGTH_V1 = 128
export const CONTACT_COMMUNICATION_ACTOR_MAX_LENGTH_V1 = 128
export const CONTACT_COMMUNICATION_REASON_MAX_LENGTH_V1 = 512

export type ContactCommunicationPermissionQueryV1 = {
  contract: typeof CONTACT_COMMUNICATION_PERMISSION_QUERY_V1
  contactId: string
  /** Typed loosely on purpose: an unsupported class is a deny result, not a parse error. */
  communicationClass: string
}

export type ContactCommunicationPermissionReasonV1 =
  | 'no_restriction'
  | 'restricted_all'
  | 'restricted_message'
  | 'restricted_voice'
  | 'contact_unknown'
  | 'contact_archived'
  | 'unsupported_communication_class'
  | 'lineage_unsafe'
  | 'policy_unavailable'

export type ContactCommunicationPermissionResultV1 = {
  contract: typeof CONTACT_COMMUNICATION_PERMISSION_RESULT_V1
  decision: 'allow' | 'deny'
  /** Meaningful on deny: true only when the store or lineage could not be established and a retry may succeed. */
  retryable: boolean
  reason: ContactCommunicationPermissionReasonV1
  requestedContactId: string
  communicationClass: string
  /** The canonical Contact the decision was made for, once lineage was established. */
  canonicalContactId: string | null
  /** The policy version the decision rests on: 0 for a known Contact without a policy row, null when not established. */
  policyVersion: number | null
}

export type SetContactCommunicationPolicyCommandV1 = {
  contract: typeof SET_CONTACT_COMMUNICATION_POLICY_COMMAND_V1
  /** Deterministic per logical request; the same id replays, a different payload under it conflicts. */
  requestId: string
  contactId: string
  /** The policy version the caller decided against; 0 for a Contact without a policy row. */
  expectedVersion: number
  /** The complete requested state, never a patch. */
  restriction: ContactCommunicationRestrictionStateV1
  actor: string
  reason: string
}

export type SetContactCommunicationPolicyResultV1 =
  | {
      contract: typeof SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1
      status: 'applied' | 'replayed'
      contactId: string
      version: number
      restriction: ContactCommunicationRestrictionStateV1
    }
  | {
      contract: typeof SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1
      status: 'idempotency_conflict'
      contactId: string
      requestId: string
    }
  | {
      contract: typeof SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1
      status: 'version_conflict'
      contactId: string
      expectedVersion: number
      currentVersion: number
    }
  | {
      contract: typeof SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1
      status: 'contact_not_found'
      contactId: string
    }
  | {
      contract: typeof SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1
      status: 'contact_not_canonical'
      contactId: string
      canonicalContactId: string
    }
  | {
      contract: typeof SET_CONTACT_COMMUNICATION_POLICY_RESULT_V1
      status: 'lineage_unsafe'
      contactId: string
      reason: string
    }

export class ContactCommunicationPolicyContractValidationError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

  constructor(code: ContactCommunicationPolicyContractValidationError['code'], message: string) {
    super(message)
    this.name = 'ContactCommunicationPolicyContractValidationError'
    this.code = code
  }
}

function invalid(message: string): never {
  throw new ContactCommunicationPolicyContractValidationError('INVALID_CONTRACT', message)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid(`${field} must be a plain object`)
  return value as Record<string, unknown>
}

/** The field set is exact: an unknown field (an override, a bypass, a channel) is refused, never ignored. */
function exactFields(value: Record<string, unknown>, supported: readonly string[], field: string): void {
  const extra = Object.keys(value).filter(key => !supported.includes(key))
  if (extra.length > 0) invalid(`unsupported ${field} field(s): ${extra.sort().join(', ')}`)
}

function assertContract(value: Record<string, unknown>, expected: string, versionPrefix: string): void {
  if (value.contract === expected) return
  if (typeof value.contract === 'string' && value.contract.startsWith(versionPrefix)) {
    throw new ContactCommunicationPolicyContractValidationError(
      'UNSUPPORTED_CONTRACT_VERSION',
      `unsupported contract version: ${value.contract}`,
    )
  }
  invalid(`contract must equal ${expected}`)
}

/** A bounded, trimmed, control-character-free identifier or text. */
function boundedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') invalid(`${field} must be a string`)
  if (value.trim() !== value || value.length === 0) invalid(`${field} must be a non-empty string without surrounding whitespace`)
  if (value.length > maxLength) invalid(`${field} must be at most ${maxLength} characters`)
  if (/[\u0000-\u001F\u007F]/u.test(value)) invalid(`${field} must not contain control characters`)
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid(`${field} must be a non-negative integer`)
  }
  return value
}

export function isContactCommunicationClassV1(value: unknown): value is ContactCommunicationClassV1 {
  return typeof value === 'string'
    && (CONTACT_COMMUNICATION_CLASSES_V1 as readonly string[]).includes(value)
}

export function parseContactCommunicationRestrictionStateV1(
  input: unknown,
  field = 'restriction',
): ContactCommunicationRestrictionStateV1 {
  const value = record(input, field)
  exactFields(value, ['denyAll', 'denyMessage', 'denyVoice'], field)
  for (const flag of ['denyAll', 'denyMessage', 'denyVoice'] as const) {
    if (typeof value[flag] !== 'boolean') invalid(`${field}.${flag} must be a boolean`)
  }
  return {
    denyAll: value.denyAll as boolean,
    denyMessage: value.denyMessage as boolean,
    denyVoice: value.denyVoice as boolean,
  }
}

/**
 * Structural validation only. A well-formed query naming an unsupported class
 * parses, so the handler can answer it with a deny rather than an exception.
 */
export function parseContactCommunicationPermissionQueryV1(input: unknown): ContactCommunicationPermissionQueryV1 {
  const value = record(input, 'query')
  assertContract(value, CONTACT_COMMUNICATION_PERMISSION_QUERY_V1, 'contacts.ContactCommunicationPermissionQuery.')
  exactFields(value, ['contract', 'contactId', 'communicationClass'], 'query')
  return {
    contract: CONTACT_COMMUNICATION_PERMISSION_QUERY_V1,
    contactId: boundedText(value.contactId, 'contactId', CONTACT_COMMUNICATION_REQUEST_ID_MAX_LENGTH_V1),
    communicationClass: boundedText(value.communicationClass, 'communicationClass', 64),
  }
}

export function parseSetContactCommunicationPolicyCommandV1(input: unknown): SetContactCommunicationPolicyCommandV1 {
  const value = record(input, 'command')
  assertContract(value, SET_CONTACT_COMMUNICATION_POLICY_COMMAND_V1, 'contacts.SetContactCommunicationPolicyCommand.')
  exactFields(value, ['contract', 'requestId', 'contactId', 'expectedVersion', 'restriction', 'actor', 'reason'], 'command')
  return {
    contract: SET_CONTACT_COMMUNICATION_POLICY_COMMAND_V1,
    requestId: boundedText(value.requestId, 'requestId', CONTACT_COMMUNICATION_REQUEST_ID_MAX_LENGTH_V1),
    contactId: boundedText(value.contactId, 'contactId', CONTACT_COMMUNICATION_REQUEST_ID_MAX_LENGTH_V1),
    expectedVersion: nonNegativeInteger(value.expectedVersion, 'expectedVersion'),
    restriction: parseContactCommunicationRestrictionStateV1(value.restriction),
    actor: boundedText(value.actor, 'actor', CONTACT_COMMUNICATION_ACTOR_MAX_LENGTH_V1),
    reason: boundedText(value.reason, 'reason', CONTACT_COMMUNICATION_REASON_MAX_LENGTH_V1),
  }
}

// Calling's public contract for a manual (human) outbound call to one Contact.
//
// The caller names a canonical Contact and one of its phones by the Contacts phone id. A phone
// number is never an input: the number always comes from Contacts' own data, and Calling checks
// the staff principal, the Contact, the number and the voice permission before anything is dialled.
// The same requestId replays; a different payload under it conflicts. An unknown dial outcome is
// never redialled.

export const START_MANUAL_CALL_COMMAND_V1 = 'calling.StartManualCallCommand.v1' as const
export const START_MANUAL_CALL_RESULT_V1 = 'calling.StartManualCallResult.v1' as const
export const MANUAL_CALL_AVAILABILITY_QUERY_V1 = 'calling.ManualCallAvailabilityQuery.v1' as const
export const MANUAL_CALL_AVAILABILITY_RESULT_V1 = 'calling.ManualCallAvailabilityResult.v1' as const
export const CANCEL_MANUAL_CALL_COMMAND_V1 = 'calling.CancelManualCallCommand.v1' as const
export const CANCEL_MANUAL_CALL_RESULT_V1 = 'calling.CancelManualCallResult.v1' as const

export type StartManualCallCommandV1 = {
  contract: typeof START_MANUAL_CALL_COMMAND_V1
  /** Deterministic per logical request (one per user intent); the same id replays. */
  requestId: string
  contactId: string
  /** ContactPersonCardPhoneV1.phoneId of this Contact. */
  phoneId: string
}

export type ManualCallRefusalV1 =
  | 'staff_not_authenticated'
  | 'staff_not_authorized'
  | 'no_extension'
  | 'contact_unknown'
  | 'contact_redirected'
  | 'contact_archived'
  | 'contact_unavailable'
  | 'no_verified_number'
  | 'voice_denied'
  | 'all_denied'
  | 'permission_unavailable'
  | 'busy'
  | 'request_conflict'
  | 'provider_unavailable'

export type StartManualCallResultV1 =
  | { contract: typeof START_MANUAL_CALL_RESULT_V1; status: 'admitted'; callId: string; fsUuid: string; replay: boolean }
  | { contract: typeof START_MANUAL_CALL_RESULT_V1; status: 'refused'; reason: ManualCallRefusalV1; retryable: boolean }
  /** The dial outcome is unknown. It is never redialled; the call record settles from telephony events. */
  | { contract: typeof START_MANUAL_CALL_RESULT_V1; status: 'indeterminate'; callId: string }

export type ManualCallAvailabilityQueryV1 = {
  contract: typeof MANUAL_CALL_AVAILABILITY_QUERY_V1
  contactId: string
}

export type ManualCallPhoneV1 = {
  phoneId: string
  /** The stored E.164 value, shown to an authorised employee exactly as the person card shows it. */
  phone: string
  preferred: boolean
}

export type ManualCallAvailabilityResultV1 =
  | { contract: typeof MANUAL_CALL_AVAILABILITY_RESULT_V1; status: 'available'; contactId: string; phones: ManualCallPhoneV1[] }
  | { contract: typeof MANUAL_CALL_AVAILABILITY_RESULT_V1; status: 'unavailable'; reason: Exclude<ManualCallRefusalV1, 'busy' | 'request_conflict' | 'provider_unavailable'> }

export type CancelManualCallCommandV1 = {
  contract: typeof CANCEL_MANUAL_CALL_COMMAND_V1
  fsUuid: string
}

export type CancelManualCallRefusalV1 = 'staff_not_authenticated' | 'staff_not_authorized' | 'call_not_found' | 'call_not_active' | 'provider_unavailable'

export type CancelManualCallResultV1 =
  | { contract: typeof CANCEL_MANUAL_CALL_RESULT_V1; status: 'cancelled' }
  | { contract: typeof CANCEL_MANUAL_CALL_RESULT_V1; status: 'refused'; reason: CancelManualCallRefusalV1 }

export class ManualCallContractError extends Error {
  readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
  constructor(code: ManualCallContractError['code'], message: string) {
    super(message)
    this.name = 'ManualCallContractError'
    this.code = code
  }
}

const REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/
const IDENTIFIER = /^[A-Za-z0-9_:.-]{1,128}$/
const FS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function invalid(message: string): never {
  throw new ManualCallContractError('INVALID_CONTRACT', message)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${field} must be an object`)
  return value as Record<string, unknown>
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], field: string): void {
  const extra = Object.keys(value).filter(key => !fields.includes(key)).sort()
  if (extra.length > 0) invalid(`${field} has unsupported fields: ${extra.join(', ')}`)
}

function contractName(value: unknown, expected: string): void {
  if (value === expected) return
  if (typeof value === 'string' && value.startsWith(expected.replace(/\.v1$/, '.v'))) {
    throw new ManualCallContractError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${value}`)
  }
  invalid(`contract must be ${expected}`)
}

function matching(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(`${field} is not valid`)
  return value
}

export function parseStartManualCallCommandV1(input: unknown): StartManualCallCommandV1 {
  const value = record(input, 'command')
  exactFields(value, ['contract', 'requestId', 'contactId', 'phoneId'], 'command')
  contractName(value.contract, START_MANUAL_CALL_COMMAND_V1)
  return {
    contract: START_MANUAL_CALL_COMMAND_V1,
    requestId: matching(value.requestId, REQUEST_ID, 'requestId'),
    contactId: matching(value.contactId, IDENTIFIER, 'contactId'),
    phoneId: matching(value.phoneId, IDENTIFIER, 'phoneId'),
  }
}

export function parseManualCallAvailabilityQueryV1(input: unknown): ManualCallAvailabilityQueryV1 {
  const value = record(input, 'query')
  exactFields(value, ['contract', 'contactId'], 'query')
  contractName(value.contract, MANUAL_CALL_AVAILABILITY_QUERY_V1)
  return { contract: MANUAL_CALL_AVAILABILITY_QUERY_V1, contactId: matching(value.contactId, IDENTIFIER, 'contactId') }
}

export function parseCancelManualCallCommandV1(input: unknown): CancelManualCallCommandV1 {
  const value = record(input, 'command')
  exactFields(value, ['contract', 'fsUuid'], 'command')
  contractName(value.contract, CANCEL_MANUAL_CALL_COMMAND_V1)
  return { contract: CANCEL_MANUAL_CALL_COMMAND_V1, fsUuid: matching(value.fsUuid, FS_UUID, 'fsUuid') }
}

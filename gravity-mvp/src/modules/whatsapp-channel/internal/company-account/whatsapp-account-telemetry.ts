/**
 * Telemetry contract for the M2A1-S3 company-account writer.
 *
 * Every emitted field is listed here and validated before it is logged. The
 * payload carries actions, outcome classes, lifecycle and trust classes, a
 * generation number, booleans and a duration, plus the opaque slot id already
 * present on every wa_* event. It never carries a PN, LID, JID, phone number,
 * account id, binding id, or any hash, digest, encoding or truncation of one.
 */
import {
    WHATSAPP_ACCOUNT_ATTESTATION_ACTIONS_V1,
    WHATSAPP_ACCOUNT_ATTESTATION_OUTCOMES_V1,
} from './whatsapp-account-attestation'

export const WHATSAPP_ACCOUNT_TELEMETRY_EVENT_V1 = 'wa_account_attestation'
export const WHATSAPP_ACCOUNT_TELEMETRY_REJECTED_EVENT_V1 = 'wa_account_attestation_telemetry_rejected'
export const WHATSAPP_ACCOUNT_CONFIRMATION_EVENT_V1 = 'wa_account_confirmation'

export const WHATSAPP_ACCOUNT_TELEMETRY_FIELDS_V1 = [
    'connectionId',
    'action',
    'outcome',
    'trustStateBefore',
    'trustStateAfter',
    'accountLifecycle',
    'generation',
    'operatorConfirmed',
    'unchangedSignal',
    'signalAgreedWithDatabase',
    'durationMs',
] as const
export type WhatsAppAccountTelemetryFieldV1 = (typeof WHATSAPP_ACCOUNT_TELEMETRY_FIELDS_V1)[number]

export const WHATSAPP_ACCOUNT_TRUST_CLASSES_V1 = [
    'absent',
    'pending',
    'verified',
    'mismatched',
    'revoked',
    'closed',
] as const
export type WhatsAppAccountTrustClassV1 = (typeof WHATSAPP_ACCOUNT_TRUST_CLASSES_V1)[number]

export const WHATSAPP_ACCOUNT_LIFECYCLE_CLASSES_V1 = [
    // `absent` asserts that no account exists; `unknown` says only that this
    // operation did not read one, which is the honest answer on a path that
    // performs no account lookup.
    'unknown',
    'absent',
    'pending_approval',
    'active',
    'rejected',
    'disabled',
    'retired',
] as const
export type WhatsAppAccountLifecycleClassV1 = (typeof WHATSAPP_ACCOUNT_LIFECYCLE_CLASSES_V1)[number]

export const WHATSAPP_ACCOUNT_CONFIRMATION_OUTCOMES_V1 = [
    'confirmed',
    'already_confirmed',
    'binding_not_found',
    'binding_not_open',
    'binding_not_pending',
    'attestation_stale',
    'attestation_incomplete',
    'transport_mismatch',
    'account_not_confirmable',
    'unauthenticated',
    'refused',
] as const
export type WhatsAppAccountConfirmationOutcomeV1 = (typeof WHATSAPP_ACCOUNT_CONFIRMATION_OUTCOMES_V1)[number]

export interface WhatsAppAccountTelemetryInputV1 {
    connectionId: string
    action: string
    outcome: string
    trustStateBefore: WhatsAppAccountTrustClassV1
    trustStateAfter: WhatsAppAccountTrustClassV1
    accountLifecycle: WhatsAppAccountLifecycleClassV1
    generation: number
    operatorConfirmed: boolean
    unchangedSignal: boolean | null
    signalAgreedWithDatabase: boolean | null
    durationMs: number
}

export type WhatsAppAccountTelemetryPayloadV1 = Readonly<Record<WhatsAppAccountTelemetryFieldV1, string | number | boolean | null>>

const SLOT_ID = /^[A-Za-z0-9_-]{1,64}$/u
const MAX_COUNT = 1_000_000
const MAX_DURATION_MS = 600_000
const BOOLEAN_OR_NULL_FIELDS = ['unchangedSignal', 'signalAgreedWithDatabase'] as const

function refuse(field: string): never {
    throw new TypeError(`whatsapp account telemetry field refused: ${field}`)
}

function count(value: unknown, field: string, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) refuse(field)
    return value
}

function member<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) refuse(field)
    return value as T
}

/**
 * Builds the only payload the writer may log. Unknown fields, missing fields
 * and values outside a field's contract are refused, so an identifier cannot
 * reach the operational log through this path.
 */
export function buildWhatsAppAccountTelemetryV1(input: WhatsAppAccountTelemetryInputV1): WhatsAppAccountTelemetryPayloadV1 {
    const supplied = Object.keys(input)
    for (const key of supplied) {
        if (!(WHATSAPP_ACCOUNT_TELEMETRY_FIELDS_V1 as readonly string[]).includes(key)) refuse(key)
    }
    for (const field of WHATSAPP_ACCOUNT_TELEMETRY_FIELDS_V1) {
        if (!supplied.includes(field)) refuse(field)
    }
    if (typeof input.connectionId !== 'string' || !SLOT_ID.test(input.connectionId)) refuse('connectionId')
    if (typeof input.operatorConfirmed !== 'boolean') refuse('operatorConfirmed')
    for (const field of BOOLEAN_OR_NULL_FIELDS) {
        const value = input[field]
        if (value !== null && typeof value !== 'boolean') refuse(field)
    }

    const outcomes = [
        ...WHATSAPP_ACCOUNT_ATTESTATION_OUTCOMES_V1,
        ...WHATSAPP_ACCOUNT_CONFIRMATION_OUTCOMES_V1,
    ] as const

    return Object.freeze({
        connectionId: input.connectionId,
        action: member(input.action, WHATSAPP_ACCOUNT_ATTESTATION_ACTIONS_V1, 'action'),
        outcome: member(input.outcome, outcomes, 'outcome'),
        trustStateBefore: member(input.trustStateBefore, WHATSAPP_ACCOUNT_TRUST_CLASSES_V1, 'trustStateBefore'),
        trustStateAfter: member(input.trustStateAfter, WHATSAPP_ACCOUNT_TRUST_CLASSES_V1, 'trustStateAfter'),
        accountLifecycle: member(input.accountLifecycle, WHATSAPP_ACCOUNT_LIFECYCLE_CLASSES_V1, 'accountLifecycle'),
        generation: count(input.generation, 'generation', MAX_COUNT),
        operatorConfirmed: input.operatorConfirmed,
        unchangedSignal: input.unchangedSignal,
        signalAgreedWithDatabase: input.signalAgreedWithDatabase,
        durationMs: count(input.durationMs, 'durationMs', MAX_DURATION_MS),
    })
}

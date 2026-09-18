/**
 * Telemetry contract for the WhatsApp pairing observation (M2A1-S2).
 *
 * Every emitted field is listed here and validated before it is logged. The
 * payload carries classes, booleans, counts, a duration, the WhatsApp Web
 * version and the opaque slot id already present on every wa_* event. It never
 * carries a PN, LID, JID, phone number, or any hash, digest, encoding or
 * truncation of one.
 */
import {
    WHATSAPP_PAGE_UNAVAILABLE_REASONS_V1,
    WHATSAPP_PAIRING_OUTCOMES_V1,
    WHATSAPP_SOCKET_STATE_CLASSES_V1,
} from './whatsapp-pairing-observation'

export const WHATSAPP_PAIRING_TELEMETRY_EVENT_V1 = 'wa_pairing_observation'
export const WHATSAPP_PAIRING_TELEMETRY_REJECTED_EVENT_V1 = 'wa_pairing_observation_telemetry_rejected'

export const WHATSAPP_PAIRING_TELEMETRY_FIELDS_V1 = [
    'connectionId',
    'instanceOrdinal',
    'lifecycleEvent',
    'reasonClass',
    'outcome',
    'readyCount',
    'coalescedReadyCount',
    'qrCount',
    'qrSeen',
    'socketStateClass',
    'hasSynced',
    'pnPresent',
    'pnShapeValid',
    'lidPresent',
    'lidShapeValid',
    'pnDiffersFromLid',
    'infoWidMatchesPn',
    'unchangedSincePreviousObservation',
    'waWebVersion',
    'durationMs',
] as const
export type WhatsAppPairingTelemetryFieldV1 = (typeof WHATSAPP_PAIRING_TELEMETRY_FIELDS_V1)[number]

export const WHATSAPP_PAIRING_LIFECYCLE_EVENTS_V1 = ['qr', 'ready', 'disconnected'] as const
export type WhatsAppPairingLifecycleEventV1 = (typeof WHATSAPP_PAIRING_LIFECYCLE_EVENTS_V1)[number]

export const WHATSAPP_PAIRING_REASON_CLASSES_V1 = [
    'none',
    ...WHATSAPP_PAGE_UNAVAILABLE_REASONS_V1,
    'deadline_exceeded',
    'logout',
    'conflict',
    'unpaired',
    'navigation',
    'other_disconnect',
] as const
export type WhatsAppPairingReasonClassV1 = (typeof WHATSAPP_PAIRING_REASON_CLASSES_V1)[number]

export interface WhatsAppPairingTelemetryInputV1 {
    connectionId: string
    instanceOrdinal: number
    lifecycleEvent: WhatsAppPairingLifecycleEventV1
    reasonClass: WhatsAppPairingReasonClassV1
    outcome: (typeof WHATSAPP_PAIRING_OUTCOMES_V1)[number]
    readyCount: number
    coalescedReadyCount: number
    qrCount: number
    qrSeen: boolean
    socketStateClass: (typeof WHATSAPP_SOCKET_STATE_CLASSES_V1)[number]
    hasSynced: boolean | null
    pnPresent: boolean | null
    pnShapeValid: boolean | null
    lidPresent: boolean | null
    lidShapeValid: boolean | null
    pnDiffersFromLid: boolean | null
    infoWidMatchesPn: boolean | null
    unchangedSincePreviousObservation: boolean | null
    waWebVersion: string | null
    durationMs: number
}

export type WhatsAppPairingTelemetryPayloadV1 = Readonly<Record<WhatsAppPairingTelemetryFieldV1, string | number | boolean | null>>

/** Slot ids are Prisma cuids: they start with a letter, so a phone-shaped value is refused. */
const SLOT_ID = /^[a-z][a-z0-9]{7,63}$/
/** major.minor.build, as WhatsApp Web reports it; anything else is logged as unrecognized. */
const WA_WEB_VERSION = /^[0-9]{1,4}\.[0-9]{1,6}\.[0-9]{1,12}$/
const MAX_COUNT = 1_000_000
const MAX_DURATION_MS = 600_000

const BOOLEAN_OR_NULL_FIELDS = [
    'hasSynced',
    'pnPresent',
    'pnShapeValid',
    'lidPresent',
    'lidShapeValid',
    'pnDiffersFromLid',
    'infoWidMatchesPn',
    'unchangedSincePreviousObservation',
] as const

function refuse(field: string): never {
    throw new TypeError(`whatsapp pairing telemetry field refused: ${field}`)
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
 * Builds the only payload the observer may log. Unknown fields, missing fields
 * and values outside a field's contract are refused, so an identifier cannot
 * reach the operational log through this path.
 */
export function buildWhatsAppPairingTelemetryV1(input: WhatsAppPairingTelemetryInputV1): WhatsAppPairingTelemetryPayloadV1 {
    const supplied = Object.keys(input)
    for (const key of supplied) {
        if (!(WHATSAPP_PAIRING_TELEMETRY_FIELDS_V1 as readonly string[]).includes(key)) refuse(key)
    }
    for (const field of WHATSAPP_PAIRING_TELEMETRY_FIELDS_V1) {
        if (!supplied.includes(field)) refuse(field)
    }
    if (typeof input.connectionId !== 'string' || !SLOT_ID.test(input.connectionId)) refuse('connectionId')
    if (typeof input.qrSeen !== 'boolean') refuse('qrSeen')
    for (const field of BOOLEAN_OR_NULL_FIELDS) {
        const value = input[field]
        if (value !== null && typeof value !== 'boolean') refuse(field)
    }
    if (input.waWebVersion !== null && typeof input.waWebVersion !== 'string') refuse('waWebVersion')

    return Object.freeze({
        connectionId: input.connectionId,
        instanceOrdinal: count(input.instanceOrdinal, 'instanceOrdinal', MAX_COUNT),
        lifecycleEvent: member(input.lifecycleEvent, WHATSAPP_PAIRING_LIFECYCLE_EVENTS_V1, 'lifecycleEvent'),
        reasonClass: member(input.reasonClass, WHATSAPP_PAIRING_REASON_CLASSES_V1, 'reasonClass'),
        outcome: member(input.outcome, WHATSAPP_PAIRING_OUTCOMES_V1, 'outcome'),
        readyCount: count(input.readyCount, 'readyCount', MAX_COUNT),
        coalescedReadyCount: count(input.coalescedReadyCount, 'coalescedReadyCount', MAX_COUNT),
        qrCount: count(input.qrCount, 'qrCount', MAX_COUNT),
        qrSeen: input.qrSeen,
        socketStateClass: member(input.socketStateClass, WHATSAPP_SOCKET_STATE_CLASSES_V1, 'socketStateClass'),
        hasSynced: input.hasSynced,
        pnPresent: input.pnPresent,
        pnShapeValid: input.pnShapeValid,
        lidPresent: input.lidPresent,
        lidShapeValid: input.lidShapeValid,
        pnDiffersFromLid: input.pnDiffersFromLid,
        infoWidMatchesPn: input.infoWidMatchesPn,
        unchangedSincePreviousObservation: input.unchangedSincePreviousObservation,
        waWebVersion: input.waWebVersion === null
            ? null
            : WA_WEB_VERSION.test(input.waWebVersion) ? input.waWebVersion : 'unrecognized',
        durationMs: count(input.durationMs, 'durationMs', MAX_DURATION_MS),
    })
}

/**
 * WhatsApp pairing observer (M2A1-S2, measurement only).
 *
 * WhatsAppService calls observeWhatsAppPairingV1 at the end of its qr, ready and
 * disconnected handlers. The call returns immediately; any page read runs later,
 * serialized per slot and bounded by a deadline, and its only effect is one
 * telemetry line. Nothing in the runtime reads the result, so account identity,
 * slot identity, send, inbound and history import authority are unchanged.
 *
 * Per-slot state is observational and safe to lose: it holds counters, a
 * pending ready request and an in-memory keyed comparison value for the last
 * complete pair, so the next observation can say whether the pair changed. The
 * comparison key is random per process and never logged, so the value cannot be
 * joined across restarts or reversed from logs. Idle and excess slot entries are
 * evicted, and a new client instance resets the per-instance counters.
 */
import { createHmac, randomBytes } from 'node:crypto'
import { operationalLogV1 } from '@/infrastructure/operations/operational-log'
import {
    classifyWhatsAppPairingObservationV1,
    readWhatsAppPairingObservationV1,
    type WhatsAppPairingObservationClientV1,
    type WhatsAppPairingObservationFlagsV1,
} from './whatsapp-pairing-observation'
import {
    buildWhatsAppPairingTelemetryV1,
    WHATSAPP_PAIRING_TELEMETRY_EVENT_V1,
    WHATSAPP_PAIRING_TELEMETRY_REJECTED_EVENT_V1,
    type WhatsAppPairingLifecycleEventV1,
    type WhatsAppPairingReasonClassV1,
} from './whatsapp-pairing-telemetry'

export interface WhatsAppPairingObservationRequestV1 {
    event: WhatsAppPairingLifecycleEventV1
    connectionId: string
    instanceId: string
    client: WhatsAppPairingObservationClientV1
    /** True while this client is still the slot's current runtime instance. */
    isCurrentInstance: () => boolean
    /** The raw whatsapp-web.js disconnect reason; only its class is logged. */
    disconnectReason?: unknown
    /**
     * Optional sink for the values of one complete observation, supplied by the
     * runtime. This module never imports, names or inspects its implementation,
     * and never depends on its result: measurement stays independent of it.
     */
    recordAttestation?: (observed: {
        connectionId: string
        instanceId: string
        pnUser: string
        lidUser: string
        unchanged: boolean | null
    }) => void
}

export interface WhatsAppPairingObserverDependenciesV1 {
    emit(event: string, context: Readonly<Record<string, unknown>>): void
    now(): number
    /** Defers work until after the calling handler has returned. */
    defer(task: () => void): void
    setTimer(callback: () => void, delayMs: number): unknown
    clearTimer(handle: unknown): void
    comparisonKey: Uint8Array
    readTimeoutMs: number
    jobDeadlineMs: number
    slotIdleTtlMs: number
    maxTrackedSlots: number
}

export interface WhatsAppPairingObserverV1 {
    observe(request: WhatsAppPairingObservationRequestV1): void
    trackedSlotCount(): number
}

interface PendingReady {
    request: WhatsAppPairingObservationRequestV1
    requestedAt: number
    /** Earlier ready events this request replaced before it ran. */
    coalescedReadyCount: number
}

interface SlotState {
    instanceId: string
    instanceOrdinal: number
    readyCount: number
    qrCount: number
    qrTelemetryEmitted: boolean
    running: boolean
    pending: PendingReady | null
    previousPairValue: string | null
    lastTouchedAt: number
}

const MAX_DURATION_MS = 600_000

const NOT_OBSERVED: Omit<WhatsAppPairingObservationFlagsV1, 'outcome' | 'reasonClass'> = {
    socketStateClass: 'unknown',
    hasSynced: null,
    pnPresent: null,
    pnShapeValid: null,
    lidPresent: null,
    lidShapeValid: null,
    pnDiffersFromLid: null,
    infoWidMatchesPn: null,
    waWebVersion: null,
}

function disconnectReasonClass(reason: unknown): WhatsAppPairingReasonClassV1 {
    switch (typeof reason === 'string' ? reason : '') {
        case 'LOGOUT': return 'logout'
        case 'CONFLICT': return 'conflict'
        case 'UNPAIRED':
        case 'UNPAIRED_IDLE': return 'unpaired'
        case 'NAVIGATION': return 'navigation'
        default: return 'other_disconnect'
    }
}

export function createWhatsAppPairingObserverV1(deps: WhatsAppPairingObserverDependenciesV1): WhatsAppPairingObserverV1 {
    const slots = new Map<string, SlotState>()

    const emitSafely = (input: Parameters<typeof buildWhatsAppPairingTelemetryV1>[0]) => {
        try {
            deps.emit(WHATSAPP_PAIRING_TELEMETRY_EVENT_V1, buildWhatsAppPairingTelemetryV1(input))
        } catch {
            try {
                deps.emit(WHATSAPP_PAIRING_TELEMETRY_REJECTED_EVENT_V1, {})
            } catch {
                // Telemetry is best effort and never reaches the caller.
            }
        }
    }

    const emitFor = (
        slot: SlotState,
        connectionId: string,
        event: WhatsAppPairingLifecycleEventV1,
        flags: Omit<WhatsAppPairingObservationFlagsV1, 'reasonClass'> & { reasonClass: WhatsAppPairingReasonClassV1 },
        unchanged: boolean | null,
        durationMs: number,
        coalescedReadyCount = 0,
    ) => {
        emitSafely({
            connectionId,
            instanceOrdinal: slot.instanceOrdinal,
            lifecycleEvent: event,
            reasonClass: flags.reasonClass,
            outcome: flags.outcome,
            readyCount: slot.readyCount,
            coalescedReadyCount,
            qrCount: slot.qrCount,
            qrSeen: slot.qrCount > 0,
            socketStateClass: flags.socketStateClass,
            hasSynced: flags.hasSynced,
            pnPresent: flags.pnPresent,
            pnShapeValid: flags.pnShapeValid,
            lidPresent: flags.lidPresent,
            lidShapeValid: flags.lidShapeValid,
            pnDiffersFromLid: flags.pnDiffersFromLid,
            infoWidMatchesPn: flags.infoWidMatchesPn,
            unchangedSincePreviousObservation: unchanged,
            waWebVersion: flags.waWebVersion,
            durationMs: Math.min(Math.max(0, Math.round(durationMs)), MAX_DURATION_MS),
        })
    }

    const sweep = (now: number, keep: string) => {
        for (const [connectionId, slot] of slots) {
            if (connectionId !== keep && !slot.running && now - slot.lastTouchedAt > deps.slotIdleTtlMs) {
                slots.delete(connectionId)
            }
        }
        if (slots.size < deps.maxTrackedSlots) return
        const evictable = [...slots.entries()]
            .filter(([connectionId, slot]) => connectionId !== keep && !slot.running)
            .sort((left, right) => left[1].lastTouchedAt - right[1].lastTouchedAt)
        for (const [connectionId] of evictable) {
            if (slots.size < deps.maxTrackedSlots) break
            slots.delete(connectionId)
        }
    }

    const slotFor = (request: WhatsAppPairingObservationRequestV1, now: number): SlotState => {
        const existing = slots.get(request.connectionId)
        if (!existing) {
            const created: SlotState = {
                instanceId: request.instanceId,
                instanceOrdinal: 1,
                readyCount: 0,
                qrCount: 0,
                qrTelemetryEmitted: false,
                running: false,
                pending: null,
                previousPairValue: null,
                lastTouchedAt: now,
            }
            slots.set(request.connectionId, created)
            return created
        }
        if (existing.instanceId !== request.instanceId) {
            existing.instanceId = request.instanceId
            existing.instanceOrdinal += 1
            existing.readyCount = 0
            existing.qrCount = 0
            existing.qrTelemetryEmitted = false
            existing.pending = null
        }
        existing.lastTouchedAt = now
        return existing
    }

    const isCurrent = (request: WhatsAppPairingObservationRequestV1, slot: SlotState) => {
        if (slot.instanceId !== request.instanceId) return false
        try {
            return request.isCurrentInstance() === true
        } catch {
            return false
        }
    }

    const observeReady = async (slot: SlotState, pending: PendingReady) => {
        const { request, requestedAt, coalescedReadyCount } = pending
        const startedAt = deps.now()
        if (startedAt - requestedAt > deps.jobDeadlineMs) {
            emitFor(slot, request.connectionId, 'ready', { outcome: 'timeout', reasonClass: 'deadline_exceeded', ...NOT_OBSERVED }, null, 0, coalescedReadyCount)
            return
        }
        if (!isCurrent(request, slot)) {
            emitFor(slot, request.connectionId, 'ready', { outcome: 'stale_instance', reasonClass: 'none', ...NOT_OBSERVED }, null, 0, coalescedReadyCount)
            return
        }
        const read = await readWhatsAppPairingObservationV1(request.client, {
            timeoutMs: deps.readTimeoutMs,
            setTimer: deps.setTimer,
            clearTimer: deps.clearTimer,
        })
        const durationMs = deps.now() - startedAt
        if (!isCurrent(request, slot)) {
            emitFor(slot, request.connectionId, 'ready', { outcome: 'stale_instance', reasonClass: 'none', ...NOT_OBSERVED }, null, durationMs, coalescedReadyCount)
            return
        }
        const { flags, comparablePair } = classifyWhatsAppPairingObservationV1(read)
        let unchanged: boolean | null = null
        if (comparablePair) {
            const value = createHmac('sha256', deps.comparisonKey)
                .update(comparablePair.pnUser)
                .update(' ')
                .update(comparablePair.lidUser)
                .digest('base64')
            unchanged = slot.previousPairValue === null ? null : slot.previousPairValue === value
            slot.previousPairValue = value
            try {
                request.recordAttestation?.({
                    connectionId: request.connectionId,
                    instanceId: request.instanceId,
                    pnUser: comparablePair.pnUser,
                    lidUser: comparablePair.lidUser,
                    unchanged,
                })
            } catch {
                // The sink must never affect measurement.
            }
        }
        emitFor(slot, request.connectionId, 'ready', flags, unchanged, durationMs, coalescedReadyCount)
    }

    const drain = async (slot: SlotState) => {
        try {
            while (slot.pending) {
                const next = slot.pending
                slot.pending = null
                try {
                    await observeReady(slot, next)
                } catch {
                    // One failed observation never stops the slot's queue.
                }
            }
        } finally {
            slot.running = false
        }
    }

    return {
        observe(request) {
            try {
                const now = deps.now()
                sweep(now, request.connectionId)
                const slot = slotFor(request, now)
                if (request.event === 'qr') {
                    slot.qrCount += 1
                    if (slot.qrTelemetryEmitted) return
                    slot.qrTelemetryEmitted = true
                    emitFor(slot, request.connectionId, 'qr', { outcome: 'gated', reasonClass: 'none', ...NOT_OBSERVED }, null, 0)
                    return
                }
                if (request.event === 'disconnected') {
                    slot.pending = null
                    emitFor(slot, request.connectionId, 'disconnected', {
                        outcome: 'unavailable',
                        reasonClass: disconnectReasonClass(request.disconnectReason),
                        ...NOT_OBSERVED,
                    }, null, 0)
                    return
                }
                slot.readyCount += 1
                slot.pending = {
                    request,
                    requestedAt: now,
                    coalescedReadyCount: slot.pending ? slot.pending.coalescedReadyCount + 1 : 0,
                }
                if (slot.running) return
                slot.running = true
                deps.defer(() => {
                    void drain(slot)
                })
            } catch {
                // Observation must never affect the WhatsApp runtime.
            }
        },
        trackedSlotCount() {
            return slots.size
        },
    }
}

const READ_TIMEOUT_MS = 5_000
const JOB_DEADLINE_MS = 15_000
const SLOT_IDLE_TTL_MS = 6 * 60 * 60 * 1000
const MAX_TRACKED_SLOTS = 64

function defaultDependencies(): WhatsAppPairingObserverDependenciesV1 {
    return {
        emit: (event, context) => operationalLogV1('info', event, context),
        now: () => Date.now(),
        defer: (task) => {
            setTimeout(task, 0)
        },
        setTimer: (callback, delayMs) => {
            const handle = setTimeout(callback, delayMs)
            if (typeof handle === 'object' && handle && 'unref' in handle && typeof handle.unref === 'function') handle.unref()
            return handle
        },
        clearTimer: (handle) => {
            if (handle !== null && handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>)
        },
        comparisonKey: randomBytes(32),
        readTimeoutMs: READ_TIMEOUT_MS,
        jobDeadlineMs: JOB_DEADLINE_MS,
        slotIdleTtlMs: SLOT_IDLE_TTL_MS,
        maxTrackedSlots: MAX_TRACKED_SLOTS,
    }
}

// One observer per process, shared by every Next bundle that loads this module.
const globalForPairingObserver = globalThis as unknown as { __yokoWhatsAppPairingObserverV1?: WhatsAppPairingObserverV1 }

/** Records one WhatsApp lifecycle event for pairing measurement. Returns immediately and never throws. */
export function observeWhatsAppPairingV1(request: WhatsAppPairingObservationRequestV1): void {
    try {
        const observer = globalForPairingObserver.__yokoWhatsAppPairingObserverV1
            ?? (globalForPairingObserver.__yokoWhatsAppPairingObserverV1 = createWhatsAppPairingObserverV1(defaultDependencies()))
        observer.observe(request)
    } catch {
        // Observation must never affect the WhatsApp runtime.
    }
}

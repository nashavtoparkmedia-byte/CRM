'use strict'

/**
 * M2A2-MAX1B0A — WebSocket generation observation.
 *
 * MAX opens several WebSockets per session: short-lived probes that handshake and
 * die, and the one socket that then carries sustained traffic. Production evidence
 * (2026-09-26, 6.5 h) is unambiguous about how to tell them apart: every sustained
 * socket carried the op:1 keepalive on its cadence and no probe carried a single
 * one, while op:19 arrived on all of them and proved nothing.
 *
 * This module is pure bookkeeping over that evidence. It answers "which generation
 * delivered this frame" and "has that generation itself proved which principal it
 * is authenticated as". It authorizes nothing: MAX1B0A is observation only, and
 * MAX1B0B is where authority becomes generation-bound.
 *
 * A principal value may enter this module to be compared with another, and never
 * leaves it: every result is a shape, a count or a classification.
 */

/** A generation is DATA once it has carried the MAX keepalive, and not before. */
const MAX_WS_KEEPALIVE_OPCODE_V1 = 1

const MAX_WS_GENERATION_ROLES_V1 = ['probe_candidate', 'data']
const MAX_WS_OWNER_PRESENCE_V1 = ['none', 'partial', 'complete']
const MAX_WS_OWNER_CONSISTENCY_V1 = ['none', 'single', 'conflicting']
const MAX_WS_PROOF_SOURCE_V1 = 'solicited_get_chats_op48'

/**
 * Diagnostic lifecycle. `proof_observed` is the only state that claims a principal
 * was proved for a generation, and even that claim is observational.
 */
const MAX_WS_DIAGNOSTIC_STATES_V1 = [
    'idle',
    'started',
    'proof_observed',
    'no_owner',
    'conflicting_owner',
    'generation_superseded',
    'timeout',
    'refused',
    'error',
]

/** The telemetry events this phase may emit, at most once each per generation. */
const MAX_WS_TELEMETRY_EVENTS_V1 = [
    'generation_created',
    'generation_closed',
    'generation_classified_data',
    'diagnostic_get_chats_started',
    'diagnostic_get_chats_result',
    'generation_superseded',
]

const OWNER_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u
const OWNER_SENTINELS = new Set(['legacy', 'max-default'])

/** A generation is an exact positive integer minted by the browser hook. */
function isExactGenerationV1(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/**
 * Normalizes a provider-owned `owner` field for comparison only. The return value
 * is used to count and to compare, and is never logged, persisted or reported.
 */
function usableOwnerV1(value) {
    if (value == null || !['string', 'number'].includes(typeof value)) return null
    const normalized = String(value)
    // Exact form only, as MAX1A already requires of a provider principal: an
    // untrimmed or oddly shaped value is an anomaly, and an anomaly must not be
    // counted as evidence of who this socket is.
    if (normalized !== normalized.trim()) return null
    if (!normalized || OWNER_SENTINELS.has(normalized)) return null
    if (!OWNER_SHAPE.test(normalized)) return null
    return normalized
}

/**
 * Structural census of a solicited GET_CHATS (op:48) response.
 *
 * Returns shapes and counts. Concrete owners are compared inside this function and
 * discarded with it, so a caller cannot obtain a principal from the result.
 */
function censusOwnerEvidenceV1(payload) {
    const chats = Array.isArray(payload)
        ? payload
        : (payload && typeof payload === 'object' && Array.isArray(payload.chats) ? payload.chats : null)
    if (chats === null) {
        return { hasChats: false, chats: 0, withOwner: 0, ownerPresence: 'none', ownerConsistency: 'none' }
    }
    let withOwner = 0
    const distinct = new Set()
    for (const chat of chats) {
        if (!chat || typeof chat !== 'object' || Array.isArray(chat)) continue
        const owner = usableOwnerV1(chat.owner)
        if (owner === null) continue
        withOwner += 1
        distinct.add(owner)
    }
    const ownerPresence = withOwner === 0
        ? 'none'
        : (withOwner === chats.length ? 'complete' : 'partial')
    const ownerConsistency = distinct.size === 0
        ? 'none'
        : (distinct.size === 1 ? 'single' : 'conflicting')
    return { hasChats: true, chats: chats.length, withOwner, ownerPresence, ownerConsistency }
}

/**
 * Decides the diagnostic outcome for a census. Conflicting owners fail closed:
 * this phase never picks one of two disagreeing provider-owned answers.
 */
function diagnosticOutcomeForCensusV1(census) {
    if (!census || census.ownerConsistency === 'conflicting') return 'conflicting_owner'
    if (census.withOwner > 0 && census.ownerConsistency === 'single') return 'proof_observed'
    return 'no_owner'
}

function emptyDiagnostic() {
    return { state: 'idle', startedAt: null, finishedAt: null, census: null }
}

/**
 * Observational state for every MAX WebSocket generation this process has seen.
 *
 * @param {{ now?: () => number }} [deps]
 */
function createWsGenerationObservationV1(deps = {}) {
    const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
    /** @type {Map<number, {generation:number, createdAt:number|null, closedAt:number|null, frames:number, keepalives:number, role:string, diagnostic:object}>} */
    const generations = new Map()
    let currentGeneration = null
    let dataGeneration = null

    function ensure(generation, at) {
        let record = generations.get(generation)
        if (record === undefined) {
            record = {
                generation,
                createdAt: at,
                closedAt: null,
                frames: 0,
                keepalives: 0,
                role: 'probe_candidate',
                diagnostic: emptyDiagnostic(),
            }
            generations.set(generation, record)
        }
        if (currentGeneration === null || generation > currentGeneration) currentGeneration = generation
        return record
    }

    return {
        /** The browser hook minted a new generation for a new MAX socket. */
        noteSocketCreated(generation, at = now()) {
            if (!isExactGenerationV1(generation)) return { accepted: false }
            const record = ensure(generation, at)
            if (record.createdAt === null) record.createdAt = at
            return { accepted: true, generation }
        },

        /** That socket closed. Its generation stays in the census, marked closed. */
        noteSocketClosed(generation, at = now()) {
            if (!isExactGenerationV1(generation)) return { accepted: false }
            const record = generations.get(generation)
            if (record === undefined) return { accepted: false }
            if (record.closedAt === null) record.closedAt = at
            return { accepted: true, generation, wasData: record.role === 'data' }
        },

        /**
         * A frame arrived on an exact generation. The keepalive — and nothing else —
         * classifies that generation as the data socket.
         */
        noteFrame(generation, opcode, at = now()) {
            if (!isExactGenerationV1(generation)) return { accepted: false, classifiedData: false, supersededGeneration: null }
            const record = ensure(generation, at)
            record.frames += 1
            if (opcode !== MAX_WS_KEEPALIVE_OPCODE_V1) {
                return { accepted: true, classifiedData: false, supersededGeneration: null }
            }
            record.keepalives += 1
            const classifiedData = record.role !== 'data'
            record.role = 'data'
            let supersededGeneration = null
            if (dataGeneration === null || generation > dataGeneration) {
                if (dataGeneration !== null && dataGeneration !== generation) supersededGeneration = dataGeneration
                dataGeneration = generation
            }
            return { accepted: true, classifiedData, supersededGeneration }
        },

        roleOf(generation) {
            const record = generations.get(generation)
            return record === undefined ? null : record.role
        },

        /** One diagnostic per data generation, and never for a probe candidate. */
        shouldRunDiagnostic(generation) {
            const record = generations.get(generation)
            if (record === undefined) return false
            if (record.role !== 'data') return false
            if (record.closedAt !== null) return false
            return record.diagnostic.state === 'idle'
        },

        markDiagnosticStarted(generation, at = now()) {
            const record = generations.get(generation)
            if (record === undefined || record.diagnostic.state !== 'idle') return false
            record.diagnostic = { state: 'started', startedAt: at, finishedAt: null, census: null }
            return true
        },

        recordDiagnosticOutcome(generation, outcome, census = null, at = now()) {
            const record = generations.get(generation)
            if (record === undefined) return false
            if (!MAX_WS_DIAGNOSTIC_STATES_V1.includes(outcome) || outcome === 'idle') return false
            record.diagnostic = {
                state: outcome,
                startedAt: record.diagnostic.startedAt,
                finishedAt: at,
                census: census === null ? null : {
                    chats: census.chats,
                    withOwner: census.withOwner,
                    ownerPresence: census.ownerPresence,
                    ownerConsistency: census.ownerConsistency,
                },
            }
            return true
        },

        /** A response may only prove the generation that is still the data socket. */
        isCurrentDataGeneration(generation) {
            return isExactGenerationV1(generation) && dataGeneration === generation
        },

        get currentGeneration() { return currentGeneration },
        get dataGeneration() { return dataGeneration },

        /** The in-memory, read-only principal observation for the data generation. */
        principalProofObservationV1() {
            const record = dataGeneration === null ? undefined : generations.get(dataGeneration)
            const diagnostic = record === undefined ? emptyDiagnostic() : record.diagnostic
            const proofObserved = diagnostic.state === 'proof_observed'
            return {
                generation: dataGeneration,
                proofObserved,
                proofSource: proofObserved ? MAX_WS_PROOF_SOURCE_V1 : null,
                ownerPresence: diagnostic.census === null ? 'none' : diagnostic.census.ownerPresence,
                ownerConsistency: diagnostic.census === null ? 'none' : diagnostic.census.ownerConsistency,
                observedAt: diagnostic.finishedAt,
            }
        },

        /** The additive `/status` shape. It carries no principal and no locator. */
        snapshot() {
            const record = dataGeneration === null ? undefined : generations.get(dataGeneration)
            const observation = this.principalProofObservationV1()
            return {
                currentGeneration,
                dataGeneration,
                dataGenerationOpen: record === undefined ? false : record.closedAt === null,
                principalProofObserved: observation.proofObserved,
                proofSource: observation.proofSource,
                ownerPresence: observation.ownerPresence,
                ownerConsistency: observation.ownerConsistency,
                diagnosticState: record === undefined ? 'idle' : record.diagnostic.state,
            }
        },
    }
}

module.exports = {
    MAX_WS_KEEPALIVE_OPCODE_V1,
    MAX_WS_GENERATION_ROLES_V1,
    MAX_WS_OWNER_PRESENCE_V1,
    MAX_WS_OWNER_CONSISTENCY_V1,
    MAX_WS_DIAGNOSTIC_STATES_V1,
    MAX_WS_TELEMETRY_EVENTS_V1,
    MAX_WS_PROOF_SOURCE_V1,
    isExactGenerationV1,
    usableOwnerV1,
    censusOwnerEvidenceV1,
    diagnosticOutcomeForCensusV1,
    createWsGenerationObservationV1,
}

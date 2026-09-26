import { createHash } from 'node:crypto'
import {
    CALLING_E164,
    callingTelephonyRuntimeConfiguration,
    evaluateCallingRuntimeReadiness,
    type CallingTelephonyRuntimeConfiguration,
    type CallingVoiceProvider,
} from './calling-runtime-readiness'

export const CONTROLLED_REAL_CALL_CONFIRMATION = 'PLACE_ONE_CONTROLLED_REAL_AI_CALL' as const
export const CONTROLLED_REAL_CALL_ATTEMPT_LIMIT = 1 as const

/**
 * Hard maximum an answered AI call may last, and the single place this repository
 * states it. Owner decision: ten minutes, one limit for inbound and outbound
 * alike, measured from the answer, cut immediately with no warning phrase. It is a
 * safety and cost limit, not a provider failure.
 *
 * Everything that enforces it derives from this constant. The originate hands
 * FreeSWITCH a scheduled hangup in whole seconds and the same policy in
 * milliseconds as a channel variable; the audio bridge reads that variable back
 * off the channel and derives its own semantic deadline from it. There is
 * deliberately no second copy — no environment variable, no configuration row, no
 * literal in the bridge — because two copies of a product policy drift.
 */
export const CONTROLLED_REAL_CALL_MAX_ANSWERED_MS = 10 * 60 * 1000

/**
 * The two representations FreeSWITCH needs, derived from one policy.
 *
 * `sched_hangup` takes whole seconds, so a policy that is not a whole number of
 * seconds cannot be expressed exactly. Rounding it up would quietly lengthen the
 * Owner's maximum and rounding down would quietly shorten it, so this refuses
 * instead: a policy that cannot be enforced exactly is a defect to fix at the
 * source, not at the call.
 */
export function controlledRealCallHardLimit(maxAnsweredMs: number = CONTROLLED_REAL_CALL_MAX_ANSWERED_MS): {
    maxAnsweredMs: number
    seconds: number
} {
    if (!Number.isSafeInteger(maxAnsweredMs) || maxAnsweredMs <= 0) {
        throw new Error(`controlled real call hard limit must be a positive integer of ms, got ${maxAnsweredMs}`)
    }
    if (maxAnsweredMs % 1000 !== 0) {
        throw new Error(`controlled real call hard limit must be a whole number of seconds, got ${maxAnsweredMs} ms`)
    }
    return { maxAnsweredMs, seconds: maxAnsweredMs / 1000 }
}

const E164 = CALLING_E164
const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/

export type ControlledVoiceProvider = CallingVoiceProvider

export type ControlledRealCallBlocker =
    | 'live_mode_disabled'
    | 'controlled_gate_disabled'
    | 'operator_auth_invalid'
    | 'approved_request_id_invalid'
    | 'telephony_provider_not_freeswitch'
    | 'allowlisted_destination_invalid'
    | 'caller_number_invalid'
    | 'dial_template_invalid'
    | 'esl_host_missing'
    | 'esl_port_invalid'
    | 'esl_password_invalid'
    | 'park_extension_invalid'
    | 'recording_path_invalid'
    | 'callback_auth_invalid'
    | 'openai_llm_not_configured'
    | 'openai_llm_not_verified'
    | 'stt_provider_not_selected'
    | 'stt_provider_not_configured'
    | 'stt_provider_not_verified'
    | 'tts_provider_not_selected'
    | 'tts_provider_not_configured'
    | 'tts_provider_not_verified'
    | 'freeswitch_not_connected'
    | 'megafon_gateway_not_registered'
    | 'audio_bridge_health_url_invalid'
    | 'audio_bridge_unreachable'

export interface ControlledRealCallProviderConfiguration extends CallingTelephonyRuntimeConfiguration {
    /** Manual one-shot admission: the single destination this gate allows. */
    allowedDestinationE164: string
    /** Manual one-shot admission: the single Owner-approved request identity. */
    approvedRequestId: string
}

export interface ControlledRealCallReadiness {
    ready: boolean
    blockers: ControlledRealCallBlocker[]
    configuration: ControlledRealCallProviderConfiguration | null
    public: {
        ready: boolean
        blockers: ControlledRealCallBlocker[]
        attemptLimit: typeof CONTROLLED_REAL_CALL_ATTEMPT_LIMIT
        automaticRetry: false
        allowedDestinationMasked: string | null
        providers: {
            telephony: 'freeswitch'
            trunk: 'megafon'
            llm: 'openai'
            stt: ControlledVoiceProvider | 'unselected'
            tts: ControlledVoiceProvider | 'unselected'
        }
    }
}

export interface ControlledRealCallReadinessInput {
    env: Readonly<Record<string, string | undefined>>
    credentials: {
        openaiConfigured: boolean
        openaiVerified: boolean
        yandexConfigured: boolean
        yandexFolderConfigured: boolean
        yandexVerified: boolean
    }
    telephony: {
        eslConnected: boolean
        megafonRegistrationState: string | null
    }
    callbackAuthenticationConfigured: boolean
    operatorAuthenticationConfigured: boolean
    audioBridgeReachable: boolean
}

export interface ControlledRealCallRequest {
    requestId: string
    confirmation: typeof CONTROLLED_REAL_CALL_CONFIRMATION
    scenarioId: string
    driverId: string | null
    contactId: string | null
    phoneNumber: string | null
}

export class ControlledRealCallInputError extends Error {
    constructor(readonly code: string) {
        super(code)
        this.name = 'ControlledRealCallInputError'
    }
}

function maskE164(value: string): string {
    return `${value.slice(0, 3)}***${value.slice(-2)}`
}

export function inspectControlledRealCallReadiness(
    input: ControlledRealCallReadinessInput,
): ControlledRealCallReadiness {
    const {
        env,
        credentials,
        telephony,
        callbackAuthenticationConfigured,
        operatorAuthenticationConfigured,
        audioBridgeReachable,
    } = input
    const blockers: ControlledRealCallBlocker[] = []
    const allowedDestination = env.AI_CALL_CONTROLLED_DESTINATION_E164?.trim() ?? ''
    const approvedRequestId = env.AI_CALL_CONTROLLED_REQUEST_ID?.trim() ?? ''
    const runtime = evaluateCallingRuntimeReadiness({
        env,
        credentials,
        telephony,
        callbackAuthenticationConfigured,
        audioBridgeReachable,
    })
    const sttProvider = runtime.sttProvider
    const ttsProvider = runtime.ttsProvider

    if (!runtime.liveModeEnabled) blockers.push('live_mode_disabled')
    if (env.AI_CALL_CONTROLLED_REAL_CALL_ENABLED !== 'true') blockers.push('controlled_gate_disabled')
    if (!operatorAuthenticationConfigured) blockers.push('operator_auth_invalid')
    if (!REQUEST_ID.test(approvedRequestId)) blockers.push('approved_request_id_invalid')
    if (!runtime.telephonyProviderFreeswitch) blockers.push('telephony_provider_not_freeswitch')
    if (!E164.test(allowedDestination)) blockers.push('allowlisted_destination_invalid')
    if (!runtime.callerNumberValid) blockers.push('caller_number_invalid')
    if (!runtime.dialTemplateValid) blockers.push('dial_template_invalid')
    if (!runtime.eslHostPresent) blockers.push('esl_host_missing')
    if (!runtime.eslPortValid) blockers.push('esl_port_invalid')
    if (!runtime.eslPasswordStrong) blockers.push('esl_password_invalid')
    if (!runtime.parkExtensionValid) blockers.push('park_extension_invalid')
    if (!runtime.recordingPathValid) blockers.push('recording_path_invalid')
    if (!runtime.callbackAuthenticationConfigured) blockers.push('callback_auth_invalid')
    if (!runtime.openaiConfigured) blockers.push('openai_llm_not_configured')
    else if (!runtime.openaiVerified) blockers.push('openai_llm_not_verified')
    if (!sttProvider) blockers.push('stt_provider_not_selected')
    else if (!runtime.sttConfigured) blockers.push('stt_provider_not_configured')
    else if (!runtime.sttVerified) blockers.push('stt_provider_not_verified')
    if (!ttsProvider) blockers.push('tts_provider_not_selected')
    else if (!runtime.ttsConfigured) blockers.push('tts_provider_not_configured')
    else if (!runtime.ttsVerified) blockers.push('tts_provider_not_verified')
    if (!runtime.eslConnected) blockers.push('freeswitch_not_connected')
    if (!runtime.megafonRegistered) blockers.push('megafon_gateway_not_registered')
    if (!runtime.audioBridgeHealthUrlValid) blockers.push('audio_bridge_health_url_invalid')
    if (!runtime.audioBridgeReachable) blockers.push('audio_bridge_unreachable')

    const ready = blockers.length === 0
    const telephonyConfiguration = callingTelephonyRuntimeConfiguration(runtime)
    const configuration = ready && telephonyConfiguration ? {
        ...telephonyConfiguration,
        allowedDestinationE164: allowedDestination,
        approvedRequestId,
    } : null

    return {
        ready,
        blockers,
        configuration,
        public: {
            ready,
            blockers,
            attemptLimit: CONTROLLED_REAL_CALL_ATTEMPT_LIMIT,
            automaticRetry: false,
            allowedDestinationMasked: E164.test(allowedDestination) ? maskE164(allowedDestination) : null,
            providers: {
                telephony: 'freeswitch',
                trunk: 'megafon',
                llm: 'openai',
                stt: sttProvider ?? 'unselected',
                tts: ttsProvider ?? 'unselected',
            },
        },
    }
}

function readOptionalString(record: Record<string, unknown>, key: string): string | null {
    const value = record[key]
    if (value == null) return null
    if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
        throw new ControlledRealCallInputError(`${key}_invalid`)
    }
    return value
}

export function parseControlledRealCallRequest(value: unknown): ControlledRealCallRequest {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ControlledRealCallInputError('body_must_be_object')
    }
    const record = value as Record<string, unknown>
    const requestId = readOptionalString(record, 'requestId')
    const confirmation = readOptionalString(record, 'confirmation')
    const scenarioId = readOptionalString(record, 'scenarioId')
    const driverId = readOptionalString(record, 'driverId')
    const contactId = readOptionalString(record, 'contactId')
    const phoneNumber = readOptionalString(record, 'phoneNumber')

    if (!requestId || !REQUEST_ID.test(requestId)) throw new ControlledRealCallInputError('requestId_invalid')
    if (confirmation !== CONTROLLED_REAL_CALL_CONFIRMATION) {
        throw new ControlledRealCallInputError('explicit_confirmation_required')
    }
    if (!scenarioId) throw new ControlledRealCallInputError('scenarioId_required')
    if ([driverId, contactId, phoneNumber].filter(Boolean).length !== 1) {
        throw new ControlledRealCallInputError('exactly_one_recipient_required')
    }
    if (phoneNumber && !E164.test(phoneNumber)) throw new ControlledRealCallInputError('phoneNumber_invalid')

    return {
        requestId,
        confirmation: CONTROLLED_REAL_CALL_CONFIRMATION,
        scenarioId,
        driverId,
        contactId,
        phoneNumber,
    }
}

export function assertControlledDestination(toNumber: string, allowedDestinationE164: string): void {
    if (!E164.test(toNumber) || toNumber !== allowedDestinationE164) {
        throw new ControlledRealCallInputError('destination_not_allowlisted')
    }
}

export function assertControlledRequestId(requestId: string, approvedRequestId: string): void {
    if (!REQUEST_ID.test(approvedRequestId) || requestId !== approvedRequestId) {
        throw new ControlledRealCallInputError('request_not_approved')
    }
}

function digest(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function controlledRealCallIdentity(requestId: string): {
    callId: string
    fsUuid: string
} {
    const identity = digest(`controlled-real-ai-call:v1\0${requestId}`)
    const fsIdentity = digest(`controlled-real-ai-call-fs:v1\0${requestId}`)
    return {
        callId: `controlled_live_${identity.slice(0, 32)}`,
        fsUuid: `${fsIdentity.slice(0, 8)}-${fsIdentity.slice(8, 12)}-4${fsIdentity.slice(13, 16)}-a${fsIdentity.slice(17, 20)}-${fsIdentity.slice(20, 32)}`,
    }
}

export function controlledRealCallFingerprint(input: {
    actorId: string
    requestId: string
    scenarioId: string
    toNumber: string
}): string {
    return digest(JSON.stringify(input))
}

export function readControlledRealCallDispatchObservation(metadata: unknown): {
    state: 'claimed' | 'accepted' | 'rejected' | 'outcome_unknown' | null
    failureCode: string | null
} {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
        return { state: null, failureCode: null }
    }
    const controlled = (metadata as Record<string, unknown>).controlledRealCallV1
    if (typeof controlled !== 'object' || controlled === null || Array.isArray(controlled)) {
        return { state: null, failureCode: null }
    }
    const record = controlled as Record<string, unknown>
    const state = ['claimed', 'accepted', 'rejected', 'outcome_unknown'].includes(String(record.dispatchState))
        ? record.dispatchState as 'claimed' | 'accepted' | 'rejected' | 'outcome_unknown'
        : null
    return {
        state,
        failureCode: typeof record.failureCode === 'string' ? record.failureCode : null,
    }
}

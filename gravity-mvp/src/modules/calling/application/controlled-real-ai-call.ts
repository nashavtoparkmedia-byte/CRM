import { createHash } from 'node:crypto'
import { isStrongMachineSecret } from './strong-machine-secret'

export const CONTROLLED_REAL_CALL_CONFIRMATION = 'PLACE_ONE_CONTROLLED_REAL_AI_CALL' as const
export const CONTROLLED_REAL_CALL_ATTEMPT_LIMIT = 1 as const

const E164 = /^\+[1-9]\d{7,14}$/
const REQUEST_ID = /^[A-Za-z0-9_-]{16,128}$/
const EXACT_MEGAFON_DIAL_TEMPLATE = 'sofia/gateway/megafon/${number}' as const

export type ControlledVoiceProvider = 'openai' | 'yandex'

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

export interface ControlledRealCallProviderConfiguration {
    telephonyProvider: 'freeswitch'
    sttProvider: ControlledVoiceProvider
    ttsProvider: ControlledVoiceProvider
    llmProvider: 'openai'
    allowedDestinationE164: string
    approvedRequestId: string
    callerNumberE164: string
    dialStringTemplate: typeof EXACT_MEGAFON_DIAL_TEMPLATE
    parkExtension: string
    esl: {
        host: string
        port: number
        password: string
    }
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

function selectedVoiceProvider(value: string | undefined): ControlledVoiceProvider | null {
    const normalized = value?.trim().toLowerCase()
    return normalized === 'openai' || normalized === 'yandex' ? normalized : null
}

function configuredForVoiceProvider(
    provider: ControlledVoiceProvider,
    credentials: ControlledRealCallReadinessInput['credentials'],
): boolean {
    return provider === 'openai'
        ? credentials.openaiConfigured
        : credentials.yandexConfigured && credentials.yandexFolderConfigured
}

function verifiedForVoiceProvider(
    provider: ControlledVoiceProvider,
    credentials: ControlledRealCallReadinessInput['credentials'],
): boolean {
    return provider === 'openai' ? credentials.openaiVerified : credentials.yandexVerified
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
    const callerNumber = env.MEGAFON_NUMBER?.trim() ?? ''
    const host = env.FS_ESL_HOST?.trim() ?? ''
    const portText = env.FS_ESL_PORT?.trim() ?? ''
    const port = Number(portText)
    const password = env.FS_ESL_PASSWORD ?? ''
    const parkExtension = env.AI_CALL_PARK_EXT?.trim() ?? ''
    const sttProvider = selectedVoiceProvider(env.AI_CALL_STT_PROVIDER)
    const ttsProvider = selectedVoiceProvider(env.AI_CALL_TTS_PROVIDER)

    if (env.AI_CALL_LIVE_MODE !== 'true') blockers.push('live_mode_disabled')
    if (env.AI_CALL_CONTROLLED_REAL_CALL_ENABLED !== 'true') blockers.push('controlled_gate_disabled')
    if (!operatorAuthenticationConfigured) blockers.push('operator_auth_invalid')
    if (!REQUEST_ID.test(approvedRequestId)) blockers.push('approved_request_id_invalid')
    if (env.AI_CALL_TELEPHONY_PROVIDER !== 'freeswitch') blockers.push('telephony_provider_not_freeswitch')
    if (!E164.test(allowedDestination)) blockers.push('allowlisted_destination_invalid')
    if (!E164.test(callerNumber)) blockers.push('caller_number_invalid')
    if (env.AI_CALL_DIAL_STRING_TEMPLATE !== EXACT_MEGAFON_DIAL_TEMPLATE) blockers.push('dial_template_invalid')
    if (!host) blockers.push('esl_host_missing')
    if (!/^\d{1,5}$/.test(portText) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        blockers.push('esl_port_invalid')
    }
    if (!isStrongMachineSecret(password, 16)) {
        blockers.push('esl_password_invalid')
    }
    if (parkExtension !== '9999') blockers.push('park_extension_invalid')
    if (env.RECORDINGS_HOST_PATH !== '/app/freeswitch-recordings') blockers.push('recording_path_invalid')
    if (!callbackAuthenticationConfigured) blockers.push('callback_auth_invalid')
    if (!credentials.openaiConfigured) blockers.push('openai_llm_not_configured')
    else if (!credentials.openaiVerified) blockers.push('openai_llm_not_verified')
    if (!sttProvider) blockers.push('stt_provider_not_selected')
    else if (!configuredForVoiceProvider(sttProvider, credentials)) blockers.push('stt_provider_not_configured')
    else if (!verifiedForVoiceProvider(sttProvider, credentials)) blockers.push('stt_provider_not_verified')
    if (!ttsProvider) blockers.push('tts_provider_not_selected')
    else if (!configuredForVoiceProvider(ttsProvider, credentials)) blockers.push('tts_provider_not_configured')
    else if (!verifiedForVoiceProvider(ttsProvider, credentials)) blockers.push('tts_provider_not_verified')
    if (!telephony.eslConnected) blockers.push('freeswitch_not_connected')
    if (telephony.megafonRegistrationState !== 'REGED') blockers.push('megafon_gateway_not_registered')
    if (env.AUDIO_BRIDGE_HEALTH_URL !== 'http://audio-bridge:3030/health') {
        blockers.push('audio_bridge_health_url_invalid')
    }
    if (!audioBridgeReachable) blockers.push('audio_bridge_unreachable')

    const ready = blockers.length === 0
    const configuration = ready && sttProvider && ttsProvider ? {
        telephonyProvider: 'freeswitch' as const,
        sttProvider,
        ttsProvider,
        llmProvider: 'openai' as const,
        allowedDestinationE164: allowedDestination,
        approvedRequestId,
        callerNumberE164: callerNumber,
        dialStringTemplate: EXACT_MEGAFON_DIAL_TEMPLATE,
        parkExtension,
        esl: { host, port, password },
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

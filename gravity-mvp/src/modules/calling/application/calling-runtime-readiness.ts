import { isStrongMachineSecret } from './strong-machine-secret'

/**
 * The runtime/telephony half of Calling live readiness, evaluated once.
 *
 * Every predicate here is about the machinery a real AI call needs — FreeSWITCH,
 * the trunk, the audio bridge, the STT/LLM/TTS providers, the callback token — and
 * none of it is about WHO may place a call. The manual one-shot admission gate
 * (operator token, approved requestId, one allowlisted destination, the controlled
 * kill switch) is deliberately absent, so an unattended caller can fail closed on
 * the same machinery without inheriting a single manual-admission rule.
 *
 * It returns predicates rather than an ordered blocker list on purpose: each caller
 * keeps ownership of its own blocker vocabulary and ordering, which is what makes
 * the extraction provably behaviour-neutral for the existing controlled route.
 */

export type CallingVoiceProvider = 'openai' | 'yandex'

export const EXACT_MEGAFON_DIAL_TEMPLATE = 'sofia/gateway/megafon/${number}' as const
export const CALLING_E164 = /^\+[1-9]\d{7,14}$/
export const EXPECTED_AUDIO_BRIDGE_HEALTH_URL = 'http://audio-bridge:3030/health'
export const EXPECTED_RECORDINGS_HOST_PATH = '/app/freeswitch-recordings'
export const EXPECTED_PARK_EXTENSION = '9999'

export interface CallingRuntimeCredentials {
    openaiConfigured: boolean
    openaiVerified: boolean
    yandexConfigured: boolean
    yandexFolderConfigured: boolean
    yandexVerified: boolean
}

export interface CallingRuntimeReadinessInput {
    env: Readonly<Record<string, string | undefined>>
    credentials: CallingRuntimeCredentials
    telephony: {
        eslConnected: boolean
        megafonRegistrationState: string | null
    }
    callbackAuthenticationConfigured: boolean
    audioBridgeReachable: boolean
}

/** The telephony configuration a live call is dialed with. No admission fields. */
export interface CallingTelephonyRuntimeConfiguration {
    telephonyProvider: 'freeswitch'
    sttProvider: CallingVoiceProvider
    ttsProvider: CallingVoiceProvider
    llmProvider: 'openai'
    callerNumberE164: string
    dialStringTemplate: typeof EXACT_MEGAFON_DIAL_TEMPLATE
    parkExtension: string
    esl: { host: string; port: number; password: string }
}

export interface CallingRuntimeReadinessFacts {
    liveModeEnabled: boolean
    telephonyProviderFreeswitch: boolean
    callerNumberValid: boolean
    dialTemplateValid: boolean
    eslHostPresent: boolean
    eslPortValid: boolean
    eslPasswordStrong: boolean
    parkExtensionValid: boolean
    recordingPathValid: boolean
    callbackAuthenticationConfigured: boolean
    openaiConfigured: boolean
    openaiVerified: boolean
    sttProvider: CallingVoiceProvider | null
    sttConfigured: boolean
    sttVerified: boolean
    ttsProvider: CallingVoiceProvider | null
    ttsConfigured: boolean
    ttsVerified: boolean
    eslConnected: boolean
    megafonRegistered: boolean
    audioBridgeHealthUrlValid: boolean
    audioBridgeReachable: boolean
    values: {
        callerNumber: string
        host: string
        port: number
        password: string
        parkExtension: string
    }
}

export function selectedCallingVoiceProvider(value: string | undefined): CallingVoiceProvider | null {
    const normalized = value?.trim().toLowerCase()
    return normalized === 'openai' || normalized === 'yandex' ? normalized : null
}

export function callingVoiceProviderConfigured(
    provider: CallingVoiceProvider,
    credentials: CallingRuntimeCredentials,
): boolean {
    return provider === 'openai'
        ? credentials.openaiConfigured
        : credentials.yandexConfigured && credentials.yandexFolderConfigured
}

export function callingVoiceProviderVerified(
    provider: CallingVoiceProvider,
    credentials: CallingRuntimeCredentials,
): boolean {
    return provider === 'openai' ? credentials.openaiVerified : credentials.yandexVerified
}

export function evaluateCallingRuntimeReadiness(
    input: CallingRuntimeReadinessInput,
): CallingRuntimeReadinessFacts {
    const { env, credentials, telephony, callbackAuthenticationConfigured, audioBridgeReachable } = input
    const callerNumber = env.MEGAFON_NUMBER?.trim() ?? ''
    const host = env.FS_ESL_HOST?.trim() ?? ''
    const portText = env.FS_ESL_PORT?.trim() ?? ''
    const port = Number(portText)
    const password = env.FS_ESL_PASSWORD ?? ''
    const parkExtension = env.AI_CALL_PARK_EXT?.trim() ?? ''
    const sttProvider = selectedCallingVoiceProvider(env.AI_CALL_STT_PROVIDER)
    const ttsProvider = selectedCallingVoiceProvider(env.AI_CALL_TTS_PROVIDER)
    return {
        liveModeEnabled: env.AI_CALL_LIVE_MODE === 'true',
        telephonyProviderFreeswitch: env.AI_CALL_TELEPHONY_PROVIDER === 'freeswitch',
        callerNumberValid: CALLING_E164.test(callerNumber),
        dialTemplateValid: env.AI_CALL_DIAL_STRING_TEMPLATE === EXACT_MEGAFON_DIAL_TEMPLATE,
        eslHostPresent: Boolean(host),
        eslPortValid: /^\d{1,5}$/.test(portText) && Number.isSafeInteger(port) && port >= 1 && port <= 65_535,
        eslPasswordStrong: isStrongMachineSecret(password, 16),
        parkExtensionValid: parkExtension === EXPECTED_PARK_EXTENSION,
        recordingPathValid: env.RECORDINGS_HOST_PATH === EXPECTED_RECORDINGS_HOST_PATH,
        callbackAuthenticationConfigured,
        openaiConfigured: credentials.openaiConfigured,
        openaiVerified: credentials.openaiVerified,
        sttProvider,
        sttConfigured: sttProvider !== null && callingVoiceProviderConfigured(sttProvider, credentials),
        sttVerified: sttProvider !== null && callingVoiceProviderVerified(sttProvider, credentials),
        ttsProvider,
        ttsConfigured: ttsProvider !== null && callingVoiceProviderConfigured(ttsProvider, credentials),
        ttsVerified: ttsProvider !== null && callingVoiceProviderVerified(ttsProvider, credentials),
        eslConnected: telephony.eslConnected,
        megafonRegistered: telephony.megafonRegistrationState === 'REGED',
        audioBridgeHealthUrlValid: env.AUDIO_BRIDGE_HEALTH_URL === EXPECTED_AUDIO_BRIDGE_HEALTH_URL,
        audioBridgeReachable,
        values: { callerNumber, host, port, password, parkExtension },
    }
}

export function callingTelephonyRuntimeConfiguration(
    facts: CallingRuntimeReadinessFacts,
): CallingTelephonyRuntimeConfiguration | null {
    if (!facts.sttProvider || !facts.ttsProvider) return null
    return {
        telephonyProvider: 'freeswitch',
        sttProvider: facts.sttProvider,
        ttsProvider: facts.ttsProvider,
        llmProvider: 'openai',
        callerNumberE164: facts.values.callerNumber,
        dialStringTemplate: EXACT_MEGAFON_DIAL_TEMPLATE,
        parkExtension: facts.values.parkExtension,
        esl: { host: facts.values.host, port: facts.values.port, password: facts.values.password },
    }
}

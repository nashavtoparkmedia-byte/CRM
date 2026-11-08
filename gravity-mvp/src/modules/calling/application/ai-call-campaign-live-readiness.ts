import {
    callingTelephonyRuntimeConfiguration,
    evaluateCallingRuntimeReadiness,
    type CallingRuntimeReadinessInput,
    type CallingTelephonyRuntimeConfiguration,
} from './calling-runtime-readiness'

/**
 * Readiness for unattended campaign dialing.
 *
 * It fails closed on the same machinery a real call needs, and on nothing else: no
 * operator token, no Owner-approved request identity, no single allowlisted
 * destination, no one-call retry posture. Those belong to the manual controlled
 * gate and must never be satisfied incidentally by a campaign worker.
 *
 * The campaign gate itself is a separate, always-closed predicate in this
 * milestone: `AI_CALL_CAMPAIGN_LIVE_DIAL_ENABLED` is named nowhere else in the
 * repository, is absent from every environment, and the campaign runtime mode still
 * refuses to select a live port at all. So a ready runtime can never make this
 * capability reachable by configuration alone.
 */

export type AiCallCampaignLiveBlocker =
    | 'campaign_live_gate_disabled'
    | 'live_mode_disabled'
    | 'telephony_provider_not_freeswitch'
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

export const AI_CALL_CAMPAIGN_LIVE_DIAL_GATE_ENV = 'AI_CALL_CAMPAIGN_LIVE_DIAL_ENABLED' as const

export interface AiCallCampaignLiveReadiness {
    ready: boolean
    blockers: AiCallCampaignLiveBlocker[]
    configuration: CallingTelephonyRuntimeConfiguration | null
}

export function inspectAiCallCampaignLiveReadiness(
    input: CallingRuntimeReadinessInput,
): AiCallCampaignLiveReadiness {
    const runtime = evaluateCallingRuntimeReadiness(input)
    const blockers: AiCallCampaignLiveBlocker[] = []

    if (input.env[AI_CALL_CAMPAIGN_LIVE_DIAL_GATE_ENV] !== 'true') blockers.push('campaign_live_gate_disabled')
    if (!runtime.liveModeEnabled) blockers.push('live_mode_disabled')
    if (!runtime.telephonyProviderFreeswitch) blockers.push('telephony_provider_not_freeswitch')
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
    if (!runtime.sttProvider) blockers.push('stt_provider_not_selected')
    else if (!runtime.sttConfigured) blockers.push('stt_provider_not_configured')
    else if (!runtime.sttVerified) blockers.push('stt_provider_not_verified')
    if (!runtime.ttsProvider) blockers.push('tts_provider_not_selected')
    else if (!runtime.ttsConfigured) blockers.push('tts_provider_not_configured')
    else if (!runtime.ttsVerified) blockers.push('tts_provider_not_verified')
    if (!runtime.eslConnected) blockers.push('freeswitch_not_connected')
    if (!runtime.megafonRegistered) blockers.push('megafon_gateway_not_registered')
    if (!runtime.audioBridgeHealthUrlValid) blockers.push('audio_bridge_health_url_invalid')
    if (!runtime.audioBridgeReachable) blockers.push('audio_bridge_unreachable')

    const ready = blockers.length === 0
    return { ready, blockers, configuration: ready ? callingTelephonyRuntimeConfiguration(runtime) : null }
}

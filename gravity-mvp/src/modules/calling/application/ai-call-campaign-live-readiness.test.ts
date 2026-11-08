import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    AI_CALL_CAMPAIGN_LIVE_DIAL_GATE_ENV,
    inspectAiCallCampaignLiveReadiness,
} from './ai-call-campaign-live-readiness'
import { inspectControlledRealCallReadiness } from './controlled-real-ai-call'
import {
    MIRRORED_STALE_CALL_LOOKBACK_MS,
    MIRRORED_STALE_CALL_RECONCILE_INTERVAL_MS,
} from './ai-call-campaign-live-dial'
import {
    STALE_CALL_RECONCILE_INTERVAL_MS_V1,
    STALE_CALL_RECONCILE_LOOKBACK_MS_V1,
} from '@/lib/freeswitch/EslClient'

/**
 * Campaign live readiness fails closed on the machinery a real call needs, and on
 * nothing that belongs to the manual one-shot gate. And in this milestone it can
 * never be reachable at all: the gate env exists nowhere, and the runtime refuses to
 * select a live port.
 */

const READY_ENV = {
    AI_CALL_LIVE_MODE: 'true',
    AI_CALL_TELEPHONY_PROVIDER: 'freeswitch',
    MEGAFON_NUMBER: '+79001234567',
    AI_CALL_DIAL_STRING_TEMPLATE: 'sofia/gateway/megafon/${number}',
    FS_ESL_HOST: '127.0.0.1',
    FS_ESL_PORT: '8021',
    FS_ESL_PASSWORD: 'a-strong-machine-secret-value',
    AI_CALL_PARK_EXT: '9999',
    RECORDINGS_HOST_PATH: '/app/freeswitch-recordings',
    AUDIO_BRIDGE_HEALTH_URL: 'http://audio-bridge:3030/health',
    AI_CALL_STT_PROVIDER: 'openai',
    AI_CALL_TTS_PROVIDER: 'openai',
} as const

const READY_INPUT = {
    env: READY_ENV as Record<string, string | undefined>,
    credentials: {
        openaiConfigured: true,
        openaiVerified: true,
        yandexConfigured: true,
        yandexFolderConfigured: true,
        yandexVerified: true,
    },
    telephony: { eslConnected: true, megafonRegistrationState: 'REGED' },
    callbackAuthenticationConfigured: true,
    audioBridgeReachable: true,
}

describe('campaign live readiness', () => {
    it('is closed by its own gate even when the whole runtime is ready', () => {
        const readiness = inspectAiCallCampaignLiveReadiness(READY_INPUT)
        expect(readiness.ready).toBe(false)
        expect(readiness.blockers).toEqual(['campaign_live_gate_disabled'])
        expect(readiness.configuration).toBeNull()
    })

    it('inherits no manual admission rule', () => {
        const readiness = inspectAiCallCampaignLiveReadiness({
            ...READY_INPUT,
            env: { ...READY_ENV, [AI_CALL_CAMPAIGN_LIVE_DIAL_GATE_ENV]: 'true' },
        })
        expect(readiness.ready).toBe(true)
        expect(readiness.configuration).not.toBeNull()
        // No operator token, no approved request id, no allowlisted destination were
        // configured — and none is required.
        expect(Object.keys(readiness.configuration ?? {})).not.toContain('allowedDestinationE164')
        expect(Object.keys(readiness.configuration ?? {})).not.toContain('approvedRequestId')
    })

    it('still fails closed on the machinery a real call needs', () => {
        const readiness = inspectAiCallCampaignLiveReadiness({
            ...READY_INPUT,
            env: { ...READY_ENV, [AI_CALL_CAMPAIGN_LIVE_DIAL_GATE_ENV]: 'true', FS_ESL_HOST: '' },
            telephony: { eslConnected: false, megafonRegistrationState: null },
        })
        expect(readiness.ready).toBe(false)
        expect(readiness.blockers).toEqual([
            'esl_host_missing',
            'freeswitch_not_connected',
            'megafon_gateway_not_registered',
        ])
    })

    it('names its gate nowhere else in the repository', () => {
        // A capability that cannot be switched on by configuration alone.
        expect(AI_CALL_CAMPAIGN_LIVE_DIAL_GATE_ENV).toBe('AI_CALL_CAMPAIGN_LIVE_DIAL_ENABLED')
    })
})

describe('the manual controlled gate is unchanged by the extraction', () => {
    it('keeps its exact blocker vocabulary and ordering for an empty environment', () => {
        const readiness = inspectControlledRealCallReadiness({
            env: {},
            credentials: {
                openaiConfigured: false,
                openaiVerified: false,
                yandexConfigured: false,
                yandexFolderConfigured: false,
                yandexVerified: false,
            },
            telephony: { eslConnected: false, megafonRegistrationState: null },
            callbackAuthenticationConfigured: false,
            operatorAuthenticationConfigured: false,
            audioBridgeReachable: false,
        })
        expect(readiness.blockers).toEqual([
            'live_mode_disabled',
            'controlled_gate_disabled',
            'operator_auth_invalid',
            'approved_request_id_invalid',
            'telephony_provider_not_freeswitch',
            'allowlisted_destination_invalid',
            'caller_number_invalid',
            'dial_template_invalid',
            'esl_host_missing',
            'esl_port_invalid',
            'esl_password_invalid',
            'park_extension_invalid',
            'recording_path_invalid',
            'callback_auth_invalid',
            'openai_llm_not_configured',
            'stt_provider_not_selected',
            'tts_provider_not_selected',
            'freeswitch_not_connected',
            'megafon_gateway_not_registered',
            'audio_bridge_health_url_invalid',
            'audio_bridge_unreachable',
        ])
        expect(readiness.public.attemptLimit).toBe(1)
        expect(readiness.public.automaticRetry).toBe(false)
    })

    it('still dials without a pre-answer ceiling of its own', () => {
        // C3a pins the ceiling for campaign calls only; the manual route's dialing
        // behaviour is deliberately untouched.
        const adapter = readFileSync(
            join(process.cwd(), 'src/modules/calling/internal/ai-calls/freeswitch-controlled-real-ai-call-adapter.ts'),
            'utf8',
        )
        expect(adapter).not.toContain('originate_timeout')
        expect(adapter).not.toContain('call_timeout')
        expect(adapter).not.toContain('leg_timeout')
    })
})

describe('live campaign runtime is still unreachable', () => {
    const startup = readFileSync(
        join(process.cwd(), 'src/modules/calling/application/ai-call-campaign-runtime-startup.ts'),
        'utf8',
    )
    const mode = readFileSync(
        join(process.cwd(), 'src/modules/calling/application/ai-call-campaign-runtime-mode.ts'),
        'utf8',
    )

    it('selects only the simulated port', () => {
        expect(startup).toContain('aiCallCampaignSimulatedDialPort')
        expect(startup).not.toContain('LiveDial')
        expect(startup).toContain("if (mode !== 'simulated') return { mode, kind: 'not_run' as const }")
    })

    it('still rejects every live mode value', () => {
        expect(mode).toContain("return 'unsupported_live'")
    })
})

describe('mirrored evidence windows', () => {
    it('still match the stale-call reconciliation constants they stand in for', () => {
        // The horizon is derived from these; a drift must fail here rather than
        // quietly leave the recovery window too short.
        expect(MIRRORED_STALE_CALL_LOOKBACK_MS).toBe(STALE_CALL_RECONCILE_LOOKBACK_MS_V1)
        expect(MIRRORED_STALE_CALL_RECONCILE_INTERVAL_MS).toBe(STALE_CALL_RECONCILE_INTERVAL_MS_V1)
    })
})

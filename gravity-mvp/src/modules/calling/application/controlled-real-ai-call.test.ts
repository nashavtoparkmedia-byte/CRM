import { describe, expect, it } from 'vitest'
import {
    assertControlledDestination,
    assertControlledRequestId,
    controlledRealCallIdentity,
    CONTROLLED_REAL_CALL_CONFIRMATION,
    ControlledRealCallInputError,
    inspectControlledRealCallReadiness,
    parseControlledRealCallRequest,
} from './controlled-real-ai-call'

function readyEnv(): Record<string, string | undefined> {
    return {
        AI_CALL_LIVE_MODE: 'true',
        AI_CALL_CONTROLLED_REAL_CALL_ENABLED: 'true',
        AI_CALL_CONTROLLED_OPERATOR_TOKEN: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/=-token',
        AI_CALL_CONTROLLED_REQUEST_ID: 'operator-proof-0001',
        AI_CALL_TELEPHONY_PROVIDER: 'freeswitch',
        AI_CALL_CONTROLLED_DESTINATION_E164: '+79990000000',
        AI_CALL_DIAL_STRING_TEMPLATE: 'sofia/gateway/megafon/${number}',
        AI_CALL_PARK_EXT: '9999',
        AI_CALL_STT_PROVIDER: 'openai',
        AI_CALL_TTS_PROVIDER: 'openai',
        MEGAFON_NUMBER: '+79991112233',
        FS_ESL_HOST: 'freeswitch',
        FS_ESL_PORT: '8021',
        FS_ESL_PASSWORD: 'not-a-default-password',
        BRIDGE_SHARED_TOKEN: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345',
        AUDIO_BRIDGE_HEALTH_URL: 'http://audio-bridge:3030/health',
        RECORDINGS_HOST_PATH: '/app/freeswitch-recordings',
    }
}

const credentials = {
    openaiConfigured: true,
    openaiVerified: true,
    yandexConfigured: false,
    yandexFolderConfigured: false,
    yandexVerified: false,
}

const telephony = {
    eslConnected: true,
    megafonRegistrationState: 'REGED',
}

describe('controlled real AI-call readiness', () => {
    it('fails closed when the live controls and required configuration are absent', () => {
        const result = inspectControlledRealCallReadiness({
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

        expect(result.ready).toBe(false)
        expect(result.configuration).toBeNull()
        expect(result.blockers).toEqual(expect.arrayContaining([
            'live_mode_disabled',
            'controlled_gate_disabled',
            'allowlisted_destination_invalid',
            'callback_auth_invalid',
            'openai_llm_not_configured',
            'freeswitch_not_connected',
            'megafon_gateway_not_registered',
        ]))
    })

    it('accepts one fully explicit OpenAI + FreeSWITCH/Megafon configuration', () => {
        const result = inspectControlledRealCallReadiness({
            env: readyEnv(), credentials, telephony, callbackAuthenticationConfigured: true,
            operatorAuthenticationConfigured: true, audioBridgeReachable: true,
        })

        expect(result.ready).toBe(true)
        expect(result.blockers).toEqual([])
        expect(result.public).toMatchObject({
            ready: true,
            attemptLimit: 1,
            automaticRetry: false,
            allowedDestinationMasked: '+79***00',
            providers: { telephony: 'freeswitch', trunk: 'megafon', llm: 'openai' },
        })
        expect(result.public).not.toHaveProperty('configuration')
    })

    it('requires the explicitly selected Yandex credentials without weakening OpenAI LLM readiness', () => {
        const env = readyEnv()
        env.AI_CALL_STT_PROVIDER = 'yandex'
        env.AI_CALL_TTS_PROVIDER = 'yandex'
        const blocked = inspectControlledRealCallReadiness({
            env, credentials, telephony, callbackAuthenticationConfigured: true,
            operatorAuthenticationConfigured: true, audioBridgeReachable: true,
        })
        expect(blocked.blockers).toEqual([
            'stt_provider_not_configured',
            'tts_provider_not_configured',
        ])

        const ready = inspectControlledRealCallReadiness({
            env,
            credentials: {
                openaiConfigured: true,
                openaiVerified: true,
                yandexConfigured: true,
                yandexFolderConfigured: true,
                yandexVerified: true,
            },
            telephony,
            callbackAuthenticationConfigured: true,
            operatorAuthenticationConfigured: true,
            audioBridgeReachable: true,
        })
        expect(ready.ready).toBe(true)
    })

    it('rejects unsafe defaults and a non-Megafon dial template', () => {
        const env = readyEnv()
        env.FS_ESL_PASSWORD = 'ClueCon'
        env.AI_CALL_DIAL_STRING_TEMPLATE = 'sofia/gateway/other/${number}'
        const result = inspectControlledRealCallReadiness({
            env, credentials, telephony, callbackAuthenticationConfigured: true,
            operatorAuthenticationConfigured: true, audioBridgeReachable: true,
        })
        expect(result.blockers).toEqual(expect.arrayContaining([
            'esl_password_invalid',
            'dial_template_invalid',
        ]))
    })
})

describe('controlled real AI-call admission', () => {
    const request = {
        requestId: 'operator-proof-0001',
        confirmation: CONTROLLED_REAL_CALL_CONFIRMATION,
        scenarioId: 'scenario-1',
        phoneNumber: '+79990000000',
    }

    it('requires explicit confirmation, a bounded idempotency key and exactly one recipient', () => {
        expect(parseControlledRealCallRequest(request)).toMatchObject(request)
        expect(() => parseControlledRealCallRequest({ ...request, confirmation: 'yes' }))
            .toThrowError(new ControlledRealCallInputError('explicit_confirmation_required'))
        expect(() => parseControlledRealCallRequest({ ...request, requestId: 'short' }))
            .toThrowError(new ControlledRealCallInputError('requestId_invalid'))
        expect(() => parseControlledRealCallRequest({ ...request, contactId: 'contact-1' }))
            .toThrowError(new ControlledRealCallInputError('exactly_one_recipient_required'))
    })

    it('permits only the exact configured destination', () => {
        expect(() => assertControlledDestination('+79990000000', '+79990000000')).not.toThrow()
        expect(() => assertControlledDestination('+79990000001', '+79990000000'))
            .toThrowError(new ControlledRealCallInputError('destination_not_allowlisted'))
        expect(() => assertControlledDestination('79990000000', '+79990000000'))
            .toThrowError(new ControlledRealCallInputError('destination_not_allowlisted'))
    })

    it('admits only the globally approved one-shot request identity', () => {
        expect(() => assertControlledRequestId('operator-proof-0001', 'operator-proof-0001')).not.toThrow()
        expect(() => assertControlledRequestId('operator-proof-0002', 'operator-proof-0001'))
            .toThrowError(new ControlledRealCallInputError('request_not_approved'))
    })

    it('derives a stable global identity for retry idempotency', () => {
        const first = controlledRealCallIdentity('operator-proof-0001')
        expect(controlledRealCallIdentity('operator-proof-0001')).toEqual(first)
        expect(controlledRealCallIdentity('operator-proof-0002')).not.toEqual(first)
        expect(first.fsUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
    })
})

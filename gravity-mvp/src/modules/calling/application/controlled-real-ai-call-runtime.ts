import { getAiCallKeysStatus } from '@/lib/ai-call/keys-status'
import { getAllPlaintext } from '@/lib/ai-call/provider-settings'
import { isBridgeMachineTokenWellFormed } from '../internal/ai-calls/bridge-machine-auth'
import { controlledRealAiCallPrismaPort } from '../internal/ai-calls/controlled-real-ai-call-prisma-adapter'
import { freeswitchControlledRealAiCallProvider } from '../internal/ai-calls/freeswitch-controlled-real-ai-call-adapter'
import { readMegafonTelephonyHealth } from '../internal/telephony-runtime'
import { changeAiCallLifecycle } from './ai-call-callback-runtime'
import {
    createControlledRealAiCallAdmissionOperation,
    type ControlledRealAiCallClaimInput,
    type ControlledRealAiCallClaimResult,
} from './controlled-real-ai-call-admission'
import {
    inspectControlledRealCallReadiness,
    type ControlledRealCallBlocker,
    type ControlledRealCallReadiness,
    type ControlledVoiceProvider,
} from './controlled-real-ai-call'
import {
    ControlledRealAiCallDispatchError,
    type ControlledRealAiCallDispatchInput,
} from './controlled-real-ai-call-provider'
import { isStrongMachineSecret } from './strong-machine-secret'

const PROVIDER_VERIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1_000
const EXPECTED_AUDIO_BRIDGE_HEALTH_URL = 'http://audio-bridge:3030/health'

export interface ControlledRealCallRouteReadiness {
    ready: boolean
    blockers: ControlledRealCallBlocker[]
    public: ControlledRealCallReadiness['public']
    admission: {
        allowedDestinationE164: string
        approvedRequestId: string
        callerNumberE164: string
        providers: {
            telephony: 'freeswitch'
            trunk: 'megafon'
            llm: 'openai'
            stt: ControlledVoiceProvider
            tts: ControlledVoiceProvider
        }
    } | null
}

function recentlyVerified(status: { lastCheckStatus: string | null; lastCheckedAt: string | null }): boolean {
    if (status.lastCheckStatus !== 'ok' || !status.lastCheckedAt) return false
    const checkedAt = Date.parse(status.lastCheckedAt)
    return Number.isFinite(checkedAt)
        && checkedAt <= Date.now()
        && Date.now() - checkedAt <= PROVIDER_VERIFICATION_MAX_AGE_MS
}

async function boundedTelephonyHealth() {
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
        readMegafonTelephonyHealth().catch(() => ({
            eslConnected: false as const,
            megafonRegistrationState: null,
        })),
        new Promise<{ eslConnected: false; megafonRegistrationState: null }>((resolve) => {
            timer = setTimeout(() => resolve({
                eslConnected: false,
                megafonRegistrationState: null,
            }), 1_500)
        }),
    ]).finally(() => {
        if (timer) clearTimeout(timer)
    })
}

async function probeAudioBridgeHealth(): Promise<boolean> {
    if (process.env.AUDIO_BRIDGE_HEALTH_URL !== EXPECTED_AUDIO_BRIDGE_HEALTH_URL) return false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1_500)
    try {
        const response = await fetch(EXPECTED_AUDIO_BRIDGE_HEALTH_URL, {
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal,
        })
        return response.ok && (await response.text()).trim() === 'ok'
    } catch {
        return false
    } finally {
        clearTimeout(timer)
    }
}

async function resolveControlledRealCallReadiness(): Promise<ControlledRealCallReadiness> {
    const [credentials, statuses, telephony, audioBridgeReachable] = await Promise.all([
        getAllPlaintext(),
        getAiCallKeysStatus(),
        boundedTelephonyHealth(),
        probeAudioBridgeHealth(),
    ])
    return inspectControlledRealCallReadiness({
        env: process.env,
        credentials: {
            openaiConfigured: Boolean(credentials.openaiApiKey),
            openaiVerified: recentlyVerified(statuses.openai),
            yandexConfigured: Boolean(credentials.yandexApiKey),
            yandexFolderConfigured: Boolean(credentials.yandexFolderId),
            yandexVerified: recentlyVerified(statuses.yandexSpeechkit),
        },
        telephony,
        callbackAuthenticationConfigured: isBridgeMachineTokenWellFormed(process.env.BRIDGE_SHARED_TOKEN),
        operatorAuthenticationConfigured: isStrongMachineSecret(
            process.env.AI_CALL_CONTROLLED_OPERATOR_TOKEN,
            43,
        ),
        audioBridgeReachable,
    })
}

export async function readControlledRealCallReadiness(): Promise<ControlledRealCallRouteReadiness> {
    const readiness = await resolveControlledRealCallReadiness()
    const configuration = readiness.configuration
    return {
        ready: readiness.ready,
        blockers: readiness.blockers,
        public: readiness.public,
        admission: configuration ? {
            allowedDestinationE164: configuration.allowedDestinationE164,
            approvedRequestId: configuration.approvedRequestId,
            callerNumberE164: configuration.callerNumberE164,
            providers: {
                telephony: configuration.telephonyProvider,
                trunk: 'megafon',
                llm: configuration.llmProvider,
                stt: configuration.sttProvider,
                tts: configuration.ttsProvider,
            },
        } : null,
    }
}

export async function dispatchControlledRealAiCall(
    input: Omit<ControlledRealAiCallDispatchInput, 'configuration'>,
): Promise<{ provider: 'freeswitch'; providerReference: string }> {
    const readiness = await resolveControlledRealCallReadiness()
    if (!readiness.ready || !readiness.configuration) {
        throw new ControlledRealAiCallDispatchError('unavailable')
    }
    const result = await freeswitchControlledRealAiCallProvider.dispatch({
        ...input,
        configuration: readiness.configuration,
    })
    return { provider: freeswitchControlledRealAiCallProvider.provider, ...result }
}

const claimControlledRealAiCallOperation = createControlledRealAiCallAdmissionOperation({
    persistence: controlledRealAiCallPrismaPort,
})

export function claimControlledRealAiCall(
    input: ControlledRealAiCallClaimInput,
): Promise<ControlledRealAiCallClaimResult> {
    return claimControlledRealAiCallOperation(input)
}

export async function recordControlledRealAiCallDispatchAccepted(input: {
    callId: string
    requestFingerprint: string
    providerReference: string
}): Promise<void> {
    await controlledRealAiCallPrismaPort.recordDispatch({
        ...input,
        state: 'accepted',
        recordedAt: new Date(),
    })
}

export async function recordControlledRealAiCallDispatchUnknown(input: {
    callId: string
    requestFingerprint: string
}): Promise<void> {
    await controlledRealAiCallPrismaPort.recordDispatch({
        ...input,
        state: 'outcome_unknown',
        failureCode: 'PROVIDER_OUTCOME_UNKNOWN',
        recordedAt: new Date(),
    })
}

export async function recordControlledRealAiCallDispatchRejected(input: {
    callId: string
    requestFingerprint: string
    failureCode: 'PROVIDER_REJECTED' | 'PROVIDER_UNAVAILABLE'
}): Promise<void> {
    await changeAiCallLifecycle(input.callId, {
        eventId: `controlled-real-ai-call-provider-failure:v1:${input.callId}:1`,
        source: 'calling_finalization',
        sourceSequence: 1,
        kind: 'provider_failed',
        target: 'failed',
    })
    await controlledRealAiCallPrismaPort.recordDispatch({
        ...input,
        state: 'rejected',
        recordedAt: new Date(),
    })
}

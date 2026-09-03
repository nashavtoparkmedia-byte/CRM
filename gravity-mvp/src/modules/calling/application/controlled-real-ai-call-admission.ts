import {
    controlledRealCallFingerprint,
    controlledRealCallIdentity,
} from './controlled-real-ai-call'

export interface ControlledRealAiCallRecord {
    id: string
    fsUuid: string | null
    managerId: string | null
    toNumber: string
    aiScenarioId: string | null
    isAi: boolean
    isSimulation: boolean
    status: string
    aiSessionStatus: string | null
    metadata: unknown
}

export interface ControlledRealAiCallClaimInput {
    actorId: string
    requestId: string
    scenarioId: string
    scenarioName: string
    toNumber: string
    fromNumber: string
    driverId: string | null
    contactId: string | null
    providers: {
        telephony: 'freeswitch'
        trunk: 'megafon'
        llm: 'openai'
        stt: 'openai' | 'yandex'
        tts: 'openai' | 'yandex'
    }
}

export interface ControlledRealAiCallStorageClaim {
    callId: string
    fsUuid: string
    requestFingerprint: string
    input: ControlledRealAiCallClaimInput
}

export type ControlledRealAiCallClaimResult =
    | {
        kind: 'claimed' | 'duplicate'
        call: ControlledRealAiCallRecord
        fsUuid: string
        requestFingerprint: string
        scenarioName: string
    }
    | { kind: 'conflict' }

export type ControlledRealAiCallDispatchState = 'accepted' | 'rejected' | 'outcome_unknown'

export interface ControlledRealAiCallPersistencePort {
    claim(input: ControlledRealAiCallStorageClaim): Promise<
        | { kind: 'claimed'; call: ControlledRealAiCallRecord }
        | { kind: 'duplicate'; call: ControlledRealAiCallRecord }
        | { kind: 'conflict' }
    >
    recordDispatch(input: {
        callId: string
        requestFingerprint: string
        state: ControlledRealAiCallDispatchState
        providerReference?: string
        failureCode?: string
        recordedAt: Date
    }): Promise<void>
}

export function createControlledRealAiCallAdmissionOperation(deps: {
    persistence: ControlledRealAiCallPersistencePort
}) {
    return async (input: ControlledRealAiCallClaimInput): Promise<ControlledRealAiCallClaimResult> => {
        const identity = controlledRealCallIdentity(input.requestId)
        const requestFingerprint = controlledRealCallFingerprint({
            actorId: input.actorId,
            requestId: input.requestId,
            scenarioId: input.scenarioId,
            toNumber: input.toNumber,
        })
        const result = await deps.persistence.claim({
            ...identity,
            requestFingerprint,
            input,
        })
        if (result.kind === 'conflict') return result
        return {
            ...result,
            fsUuid: identity.fsUuid,
            requestFingerprint,
            scenarioName: input.scenarioName,
        }
    }
}

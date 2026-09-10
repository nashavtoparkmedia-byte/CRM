import type { ControlledRealCallProviderConfiguration } from './controlled-real-ai-call'

export interface ControlledRealAiCallDispatchInput {
    fsUuid: string
    toNumber: string
    configuration: ControlledRealCallProviderConfiguration
}

export interface ControlledRealAiCallProviderPort {
    readonly provider: 'freeswitch'
    dispatch(input: ControlledRealAiCallDispatchInput): Promise<{ providerReference: string }>
}

export type ControlledRealAiCallDispatchFailure = 'rejected' | 'unavailable' | 'outcome_unknown'

export class ControlledRealAiCallDispatchError extends Error {
    constructor(readonly failure: ControlledRealAiCallDispatchFailure) {
        super(`controlled real AI call dispatch ${failure}`)
        this.name = 'ControlledRealAiCallDispatchError'
    }
}

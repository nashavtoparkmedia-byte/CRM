export const GET_AI_INTERN_STATE_QUERY_V1 = 'calling.GetAiInternStateQuery.v1' as const
export const GET_AI_INTERN_STATE_RESULT_V1 = 'calling.GetAiInternStateResult.v1' as const
export const SET_AI_INTERN_STATE_COMMAND_V1 = 'calling.SetAiInternStateCommand.v1' as const
export const SET_AI_INTERN_STATE_RESULT_V1 = 'calling.SetAiInternStateResult.v1' as const

export interface GetAiInternStateQueryV1 {
    contract: typeof GET_AI_INTERN_STATE_QUERY_V1
}

export interface GetAiInternStateResultV1 {
    contract: typeof GET_AI_INTERN_STATE_RESULT_V1
    internEnabled: boolean | null
}

export interface SetAiInternStateCommandV1 {
    contract: typeof SET_AI_INTERN_STATE_COMMAND_V1
    enabled: boolean
}

export interface SetAiInternStateResultV1 {
    contract: typeof SET_AI_INTERN_STATE_RESULT_V1
    saved: boolean
}

export class AiInternControlValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: AiInternControlValidationError['code'], message: string) {
        super(message)
        this.name = 'AiInternControlValidationError'
        this.code = code
    }
}

function invalid(message: string): never {
    throw new AiInternControlValidationError('INVALID_CONTRACT', message)
}

function parseContract<T extends string>(
    input: unknown,
    expected: T,
    prefix: string,
    fields: string[],
): Record<string, unknown> & { contract: T } {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        invalid('AI intern control input must be an object')
    }
    const record = input as Record<string, unknown>
    const unexpected = Object.keys(record).filter((key) => !fields.includes(key))
    if (unexpected.length > 0) invalid(`unsupported field(s): ${unexpected.sort().join(', ')}`)
    if (record.contract !== expected) {
        if (typeof record.contract === 'string' && record.contract.startsWith(prefix)) {
            throw new AiInternControlValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${record.contract}`,
            )
        }
        invalid(`contract must equal ${expected}`)
    }
    return record as Record<string, unknown> & { contract: T }
}

export function parseGetAiInternStateQueryV1(input: unknown): GetAiInternStateQueryV1 {
    return parseContract(
        input,
        GET_AI_INTERN_STATE_QUERY_V1,
        'calling.GetAiInternStateQuery.',
        ['contract'],
    )
}

export function parseSetAiInternStateCommandV1(input: unknown): SetAiInternStateCommandV1 {
    const record = parseContract(
        input,
        SET_AI_INTERN_STATE_COMMAND_V1,
        'calling.SetAiInternStateCommand.',
        ['contract', 'enabled'],
    )
    if (typeof record.enabled !== 'boolean') invalid('enabled must be a boolean')
    return record as unknown as SetAiInternStateCommandV1
}

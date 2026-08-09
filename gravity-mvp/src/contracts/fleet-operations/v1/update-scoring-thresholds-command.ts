export const UPDATE_SCORING_THRESHOLDS_COMMAND_V1 = 'fleet_operations.UpdateScoringThresholdsCommand.v1' as const
export const UPDATE_SCORING_THRESHOLDS_RESULT_V1 = 'fleet_operations.UpdateScoringThresholdsResult.v1' as const

export interface UpdateScoringThresholdsCommandV1 {
    contract: typeof UPDATE_SCORING_THRESHOLDS_COMMAND_V1
    thresholds: Record<string, number>
}

export interface UpdateScoringThresholdsResultV1 {
    contract: typeof UPDATE_SCORING_THRESHOLDS_RESULT_V1
    updated: number
}

export class UpdateScoringThresholdsValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: UpdateScoringThresholdsValidationError['code'], message: string) {
        super(message)
        this.name = 'UpdateScoringThresholdsValidationError'
        this.code = code
    }
}

const FIELDS = new Set(['contract', 'thresholds'])
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

function invalid(message: string): never {
    throw new UpdateScoringThresholdsValidationError('INVALID_CONTRACT', message)
}

export function parseUpdateScoringThresholdsCommandV1(input: unknown): UpdateScoringThresholdsCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== UPDATE_SCORING_THRESHOLDS_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('fleet_operations.UpdateScoringThresholdsCommand.')) {
            throw new UpdateScoringThresholdsValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${UPDATE_SCORING_THRESHOLDS_COMMAND_V1}`)
    }
    if (!isRecord(input.thresholds)) invalid('thresholds must be an object')
    for (const [key, value] of Object.entries(input.thresholds)) {
        if (key.length === 0) invalid('threshold keys must not be empty')
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            invalid(`threshold ${key} must be a finite number`)
        }
    }
    return input as unknown as UpdateScoringThresholdsCommandV1
}

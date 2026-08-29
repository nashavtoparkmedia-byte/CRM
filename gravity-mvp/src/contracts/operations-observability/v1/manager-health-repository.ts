export const ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1 = 'operations_observability.EnsureManagerHealthRepositoryCommand.v1' as const
export const ENSURE_MANAGER_HEALTH_REPOSITORY_RESULT_V1 = 'operations_observability.EnsureManagerHealthRepositoryResult.v1' as const
export const LIST_MANAGER_HEALTH_SNAPSHOTS_QUERY_V1 = 'operations_observability.ListManagerHealthSnapshotsQuery.v1' as const
export const LIST_MANAGER_HEALTH_SNAPSHOTS_RESULT_V1 = 'operations_observability.ListManagerHealthSnapshotsResult.v1' as const
export const SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1 = 'operations_observability.SaveManagerHealthScoresCommand.v1' as const
export const SAVE_MANAGER_HEALTH_SCORES_RESULT_V1 = 'operations_observability.SaveManagerHealthScoresResult.v1' as const
export const LIST_MANAGER_HEALTH_HISTORY_QUERY_V1 = 'operations_observability.ListManagerHealthHistoryQuery.v1' as const
export const LIST_MANAGER_HEALTH_HISTORY_RESULT_V1 = 'operations_observability.ListManagerHealthHistoryResult.v1' as const

export const MANAGER_HEALTH_LEVELS_V1 = ['healthy', 'warning', 'critical'] as const
export const MANAGER_HEALTH_MAX_HISTORY_PERIOD_DAYS_V1 = 30 as const
export type ManagerHealthLevelV1 = typeof MANAGER_HEALTH_LEVELS_V1[number]

export interface EnsureManagerHealthRepositoryCommandV1 {
    contract: typeof ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1
}

export interface EnsureManagerHealthRepositoryResultV1 {
    contract: typeof ENSURE_MANAGER_HEALTH_REPOSITORY_RESULT_V1
    completed: true
}

export interface ListManagerHealthSnapshotsQueryV1 {
    contract: typeof LIST_MANAGER_HEALTH_SNAPSHOTS_QUERY_V1
}

export interface ManagerHealthSnapshotV1 {
    managerId: string
    score: number
    declineStreak: number
}

export interface ListManagerHealthSnapshotsResultV1 {
    contract: typeof LIST_MANAGER_HEALTH_SNAPSHOTS_RESULT_V1
    items: ManagerHealthSnapshotV1[]
}

export interface ManagerHealthScoreInputV1 {
    managerId: string
    score: number
    declineStreak: number
    healthLevel: ManagerHealthLevelV1
}

export interface SaveManagerHealthScoresCommandV1 {
    contract: typeof SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1
    items: ManagerHealthScoreInputV1[]
}

export interface SaveManagerHealthScoresResultV1 {
    contract: typeof SAVE_MANAGER_HEALTH_SCORES_RESULT_V1
    completed: true
}

export interface ListManagerHealthHistoryQueryV1 {
    contract: typeof LIST_MANAGER_HEALTH_HISTORY_QUERY_V1
    managerIds: string[]
    periodDays: number
}

export interface ManagerHealthHistoryPointV1 {
    managerId: string
    score: number
    healthLevel: ManagerHealthLevelV1
    recordedAt: Date
}

export interface ListManagerHealthHistoryResultV1 {
    contract: typeof LIST_MANAGER_HEALTH_HISTORY_RESULT_V1
    items: ManagerHealthHistoryPointV1[]
}

export class ManagerHealthRepositoryContractValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: ManagerHealthRepositoryContractValidationError['code'], message: string) {
        super(message)
        this.name = 'ManagerHealthRepositoryContractValidationError'
        this.code = code
    }
}

const HEALTH_LEVELS = new Set<ManagerHealthLevelV1>(MANAGER_HEALTH_LEVELS_V1)
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.trim() !== ''
const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value)

function invalid(message: string): never {
    throw new ManagerHealthRepositoryContractValidationError('INVALID_CONTRACT', message)
}

function envelope(
    input: unknown,
    expected: string,
    prefix: string,
    fields: readonly string[],
): Record<string, unknown> {
    if (!isRecord(input)) invalid('request must be an object')
    const extra = Object.keys(input).filter(key => !fields.includes(key))
    if (extra.length > 0) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
    if (input.contract !== expected) {
        if (typeof input.contract === 'string' && input.contract.startsWith(prefix)) {
            throw new ManagerHealthRepositoryContractValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${expected}`)
    }
    return input
}

function contractOnly(input: unknown, expected: string, prefix: string): Record<string, unknown> {
    return envelope(input, expected, prefix, ['contract'])
}

function parseScoreItem(input: unknown, index: number): ManagerHealthScoreInputV1 {
    if (!isRecord(input)) invalid(`items[${index}] must be an object`)
    const fields = ['managerId', 'score', 'declineStreak', 'healthLevel']
    const extra = Object.keys(input).filter(key => !fields.includes(key))
    if (extra.length > 0) invalid(`items[${index}] has unsupported field(s): ${extra.sort().join(', ')}`)
    if (!isNonEmptyString(input.managerId)) invalid(`items[${index}].managerId must be a non-empty string`)
    if (!isFiniteNumber(input.score)) invalid(`items[${index}].score must be a finite number`)
    if (!isFiniteNumber(input.declineStreak)) invalid(`items[${index}].declineStreak must be a finite number`)
    if (typeof input.healthLevel !== 'string' || !HEALTH_LEVELS.has(input.healthLevel as ManagerHealthLevelV1)) {
        invalid(`items[${index}].healthLevel must be healthy, warning, or critical`)
    }
    return input as unknown as ManagerHealthScoreInputV1
}

export function parseEnsureManagerHealthRepositoryCommandV1(
    input: unknown,
): EnsureManagerHealthRepositoryCommandV1 {
    return contractOnly(
        input,
        ENSURE_MANAGER_HEALTH_REPOSITORY_COMMAND_V1,
        'operations_observability.EnsureManagerHealthRepositoryCommand.',
    ) as unknown as EnsureManagerHealthRepositoryCommandV1
}

export function parseListManagerHealthSnapshotsQueryV1(
    input: unknown,
): ListManagerHealthSnapshotsQueryV1 {
    return contractOnly(
        input,
        LIST_MANAGER_HEALTH_SNAPSHOTS_QUERY_V1,
        'operations_observability.ListManagerHealthSnapshotsQuery.',
    ) as unknown as ListManagerHealthSnapshotsQueryV1
}

export function parseSaveManagerHealthScoresCommandV1(input: unknown): SaveManagerHealthScoresCommandV1 {
    const value = envelope(
        input,
        SAVE_MANAGER_HEALTH_SCORES_COMMAND_V1,
        'operations_observability.SaveManagerHealthScoresCommand.',
        ['contract', 'items'],
    )
    if (!Array.isArray(value.items)) invalid('items must be an array')
    value.items.forEach((item, index) => parseScoreItem(item, index))
    return value as unknown as SaveManagerHealthScoresCommandV1
}

export function parseListManagerHealthHistoryQueryV1(
    input: unknown,
): ListManagerHealthHistoryQueryV1 {
    const value = envelope(
        input,
        LIST_MANAGER_HEALTH_HISTORY_QUERY_V1,
        'operations_observability.ListManagerHealthHistoryQuery.',
        ['contract', 'managerIds', 'periodDays'],
    )
    if (!Array.isArray(value.managerIds)) invalid('managerIds must be an array')
    value.managerIds.forEach((managerId, index) => {
        if (!isNonEmptyString(managerId)) invalid(`managerIds[${index}] must be a non-empty string`)
    })
    if (!isFiniteNumber(value.periodDays)) invalid('periodDays must be a finite number')
    if (value.periodDays > MANAGER_HEALTH_MAX_HISTORY_PERIOD_DAYS_V1) {
        invalid(`periodDays must be at most ${MANAGER_HEALTH_MAX_HISTORY_PERIOD_DAYS_V1}`)
    }
    return value as unknown as ListManagerHealthHistoryQueryV1
}

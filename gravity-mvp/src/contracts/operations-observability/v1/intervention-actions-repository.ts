export const ENSURE_INTERVENTION_ACTIONS_REPOSITORY_COMMAND_V1 = 'operations_observability.EnsureInterventionActionsRepositoryCommand.v1' as const
export const ENSURE_INTERVENTION_ACTIONS_REPOSITORY_RESULT_V1 = 'operations_observability.EnsureInterventionActionsRepositoryResult.v1' as const
export const CREATE_INTERVENTION_ACTION_COMMAND_V1 = 'operations_observability.CreateInterventionActionCommand.v1' as const
export const CREATE_INTERVENTION_ACTION_RESULT_V1 = 'operations_observability.CreateInterventionActionResult.v1' as const
export const LIST_PENDING_INTERVENTION_ACTIONS_QUERY_V1 = 'operations_observability.ListPendingInterventionActionsQuery.v1' as const
export const LIST_PENDING_INTERVENTION_ACTIONS_RESULT_V1 = 'operations_observability.ListPendingInterventionActionsResult.v1' as const
export const SET_INTERVENTION_OUTCOME_COMMAND_V1 = 'operations_observability.SetInterventionOutcomeCommand.v1' as const
export const SET_INTERVENTION_OUTCOME_RESULT_V1 = 'operations_observability.SetInterventionOutcomeResult.v1' as const
export const LIST_LATEST_INTERVENTION_ACTIONS_QUERY_V1 = 'operations_observability.ListLatestInterventionActionsQuery.v1' as const
export const LIST_LATEST_INTERVENTION_ACTIONS_RESULT_V1 = 'operations_observability.ListLatestInterventionActionsResult.v1' as const
export const LIST_INTERVENTION_OUTCOME_COUNTS_QUERY_V1 = 'operations_observability.ListInterventionOutcomeCountsQuery.v1' as const
export const LIST_INTERVENTION_OUTCOME_COUNTS_RESULT_V1 = 'operations_observability.ListInterventionOutcomeCountsResult.v1' as const
export const LIST_COMPLETED_INTERVENTION_TIMES_QUERY_V1 = 'operations_observability.ListCompletedInterventionTimesQuery.v1' as const
export const LIST_COMPLETED_INTERVENTION_TIMES_RESULT_V1 = 'operations_observability.ListCompletedInterventionTimesResult.v1' as const

export type InterventionOutcomeV1 = 'improved' | 'unchanged' | 'worsened'
export const INTERVENTION_ACTIONS_V1 = [
    'coaching',
    'reassigned_tasks',
    'workload_adjusted',
    'escalation_reviewed',
    'no_action_needed',
] as const
export type InterventionActionV1 = typeof INTERVENTION_ACTIONS_V1[number]

export interface EnsureInterventionActionsRepositoryCommandV1 {
    contract: typeof ENSURE_INTERVENTION_ACTIONS_REPOSITORY_COMMAND_V1
}
export interface EnsureInterventionActionsRepositoryResultV1 {
    contract: typeof ENSURE_INTERVENTION_ACTIONS_REPOSITORY_RESULT_V1
    completed: true
}
export interface CreateInterventionActionCommandV1 {
    contract: typeof CREATE_INTERVENTION_ACTION_COMMAND_V1
    id: string
    managerId: string
    action: InterventionActionV1
    comment: string | null
    scoreAtAction: number | null
}
export interface CreateInterventionActionResultV1 {
    contract: typeof CREATE_INTERVENTION_ACTION_RESULT_V1
    completed: true
}
export interface ListPendingInterventionActionsQueryV1 {
    contract: typeof LIST_PENDING_INTERVENTION_ACTIONS_QUERY_V1
    eligibleAtOrBefore: Date
}
export interface PendingInterventionActionV1 {
    id: string
    managerId: string
    scoreAtAction: number
}
export interface ListPendingInterventionActionsResultV1 {
    contract: typeof LIST_PENDING_INTERVENTION_ACTIONS_RESULT_V1
    items: PendingInterventionActionV1[]
}
export interface SetInterventionOutcomeCommandV1 {
    contract: typeof SET_INTERVENTION_OUTCOME_COMMAND_V1
    id: string
    outcome: InterventionOutcomeV1
}
export interface SetInterventionOutcomeResultV1 {
    contract: typeof SET_INTERVENTION_OUTCOME_RESULT_V1
    completed: true
}
export interface ListLatestInterventionActionsQueryV1 {
    contract: typeof LIST_LATEST_INTERVENTION_ACTIONS_QUERY_V1
}
export interface LatestInterventionActionV1 {
    managerId: string
    action: string
    comment: string | null
    scoreAtAction: number | null
    outcome: string | null
    createdAt: Date
}
export interface ListLatestInterventionActionsResultV1 {
    contract: typeof LIST_LATEST_INTERVENTION_ACTIONS_RESULT_V1
    items: LatestInterventionActionV1[]
}
export interface ListInterventionOutcomeCountsQueryV1 {
    contract: typeof LIST_INTERVENTION_OUTCOME_COUNTS_QUERY_V1
}
export interface InterventionOutcomeCountV1 {
    action: string
    outcome: string
    total: string
}
export interface ListInterventionOutcomeCountsResultV1 {
    contract: typeof LIST_INTERVENTION_OUTCOME_COUNTS_RESULT_V1
    items: InterventionOutcomeCountV1[]
}
export interface ListCompletedInterventionTimesQueryV1 {
    contract: typeof LIST_COMPLETED_INTERVENTION_TIMES_QUERY_V1
}
export interface CompletedInterventionTimeV1 {
    createdAt: Date
}
export interface ListCompletedInterventionTimesResultV1 {
    contract: typeof LIST_COMPLETED_INTERVENTION_TIMES_RESULT_V1
    items: CompletedInterventionTimeV1[]
}

export class InterventionActionsRepositoryContractValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: InterventionActionsRepositoryContractValidationError['code'], message: string) {
        super(message)
        this.name = 'InterventionActionsRepositoryContractValidationError'
        this.code = code
    }
}

const OUTCOMES = new Set<InterventionOutcomeV1>(['improved', 'unchanged', 'worsened'])
const ACTIONS = new Set<InterventionActionV1>(INTERVENTION_ACTIONS_V1)
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.trim() !== ''
const isNullableString = (value: unknown): value is string | null =>
    value === null || typeof value === 'string'
const isNullableFiniteNumber = (value: unknown): value is number | null =>
    value === null || (typeof value === 'number' && Number.isFinite(value))

function invalid(message: string): never {
    throw new InterventionActionsRepositoryContractValidationError('INVALID_CONTRACT', message)
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
            throw new InterventionActionsRepositoryContractValidationError(
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

export function parseEnsureInterventionActionsRepositoryCommandV1(
    input: unknown,
): EnsureInterventionActionsRepositoryCommandV1 {
    return contractOnly(
        input,
        ENSURE_INTERVENTION_ACTIONS_REPOSITORY_COMMAND_V1,
        'operations_observability.EnsureInterventionActionsRepositoryCommand.',
    ) as unknown as EnsureInterventionActionsRepositoryCommandV1
}

export function parseCreateInterventionActionCommandV1(input: unknown): CreateInterventionActionCommandV1 {
    const value = envelope(
        input,
        CREATE_INTERVENTION_ACTION_COMMAND_V1,
        'operations_observability.CreateInterventionActionCommand.',
        ['contract', 'id', 'managerId', 'action', 'comment', 'scoreAtAction'],
    )
    for (const field of ['id', 'managerId']) {
        if (!isNonEmptyString(value[field])) invalid(`${field} must be a non-empty string`)
    }
    if (typeof value.action !== 'string' || !ACTIONS.has(value.action as InterventionActionV1)) {
        invalid('action is invalid')
    }
    if (!isNullableString(value.comment)) invalid('comment must be a string or null')
    if (!isNullableFiniteNumber(value.scoreAtAction)) invalid('scoreAtAction must be a finite number or null')
    return value as unknown as CreateInterventionActionCommandV1
}

export function parseListPendingInterventionActionsQueryV1(
    input: unknown,
): ListPendingInterventionActionsQueryV1 {
    const value = envelope(
        input,
        LIST_PENDING_INTERVENTION_ACTIONS_QUERY_V1,
        'operations_observability.ListPendingInterventionActionsQuery.',
        ['contract', 'eligibleAtOrBefore'],
    )
    if (!(value.eligibleAtOrBefore instanceof Date) || !Number.isFinite(value.eligibleAtOrBefore.getTime())) {
        invalid('eligibleAtOrBefore must be a valid Date')
    }
    return value as unknown as ListPendingInterventionActionsQueryV1
}

export function parseSetInterventionOutcomeCommandV1(input: unknown): SetInterventionOutcomeCommandV1 {
    const value = envelope(
        input,
        SET_INTERVENTION_OUTCOME_COMMAND_V1,
        'operations_observability.SetInterventionOutcomeCommand.',
        ['contract', 'id', 'outcome'],
    )
    if (!isNonEmptyString(value.id)) invalid('id must be a non-empty string')
    if (typeof value.outcome !== 'string' || !OUTCOMES.has(value.outcome as InterventionOutcomeV1)) {
        invalid('outcome must be improved, unchanged, or worsened')
    }
    return value as unknown as SetInterventionOutcomeCommandV1
}

export function parseListLatestInterventionActionsQueryV1(
    input: unknown,
): ListLatestInterventionActionsQueryV1 {
    return contractOnly(
        input,
        LIST_LATEST_INTERVENTION_ACTIONS_QUERY_V1,
        'operations_observability.ListLatestInterventionActionsQuery.',
    ) as unknown as ListLatestInterventionActionsQueryV1
}

export function parseListInterventionOutcomeCountsQueryV1(
    input: unknown,
): ListInterventionOutcomeCountsQueryV1 {
    return contractOnly(
        input,
        LIST_INTERVENTION_OUTCOME_COUNTS_QUERY_V1,
        'operations_observability.ListInterventionOutcomeCountsQuery.',
    ) as unknown as ListInterventionOutcomeCountsQueryV1
}

export function parseListCompletedInterventionTimesQueryV1(
    input: unknown,
): ListCompletedInterventionTimesQueryV1 {
    return contractOnly(
        input,
        LIST_COMPLETED_INTERVENTION_TIMES_QUERY_V1,
        'operations_observability.ListCompletedInterventionTimesQuery.',
    ) as unknown as ListCompletedInterventionTimesQueryV1
}

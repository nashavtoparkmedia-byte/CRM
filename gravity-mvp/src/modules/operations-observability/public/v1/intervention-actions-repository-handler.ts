import {
    CREATE_INTERVENTION_ACTION_RESULT_V1,
    ENSURE_INTERVENTION_ACTIONS_REPOSITORY_RESULT_V1,
    LIST_COMPLETED_INTERVENTION_TIMES_RESULT_V1,
    LIST_INTERVENTION_OUTCOME_COUNTS_RESULT_V1,
    LIST_LATEST_INTERVENTION_ACTIONS_RESULT_V1,
    LIST_PENDING_INTERVENTION_ACTIONS_RESULT_V1,
    SET_INTERVENTION_OUTCOME_RESULT_V1,
    parseCreateInterventionActionCommandV1,
    parseEnsureInterventionActionsRepositoryCommandV1,
    parseListCompletedInterventionTimesQueryV1,
    parseListInterventionOutcomeCountsQueryV1,
    parseListLatestInterventionActionsQueryV1,
    parseListPendingInterventionActionsQueryV1,
    parseSetInterventionOutcomeCommandV1,
    type CompletedInterventionTimeV1,
    type CreateInterventionActionCommandV1,
    type CreateInterventionActionResultV1,
    type EnsureInterventionActionsRepositoryCommandV1,
    type EnsureInterventionActionsRepositoryResultV1,
    type InterventionOutcomeCountV1,
    type InterventionOutcomeV1,
    type LatestInterventionActionV1,
    type ListCompletedInterventionTimesQueryV1,
    type ListCompletedInterventionTimesResultV1,
    type ListInterventionOutcomeCountsQueryV1,
    type ListInterventionOutcomeCountsResultV1,
    type ListLatestInterventionActionsQueryV1,
    type ListLatestInterventionActionsResultV1,
    type ListPendingInterventionActionsQueryV1,
    type ListPendingInterventionActionsResultV1,
    type PendingInterventionActionV1,
    type SetInterventionOutcomeCommandV1,
    type SetInterventionOutcomeResultV1,
} from '../../../../contracts/operations-observability/v1'

export interface InterventionActionsRepositoryPortV1 {
    ensure(): Promise<void>
    create(input: Omit<CreateInterventionActionCommandV1, 'contract'>): Promise<void>
    listPending(eligibleAtOrBefore: Date): Promise<PendingInterventionActionV1[]>
    setOutcome(input: { id: string; outcome: InterventionOutcomeV1 }): Promise<void>
    listLatest(): Promise<LatestInterventionActionV1[]>
    listOutcomeCounts(): Promise<InterventionOutcomeCountV1[]>
    listCompletedTimes(): Promise<CompletedInterventionTimeV1[]>
}

export function createEnsureInterventionActionsRepositoryHandlerV1(
    port: InterventionActionsRepositoryPortV1,
) {
    return async function ensureInterventionActionsRepositoryV1(
        command: EnsureInterventionActionsRepositoryCommandV1 | unknown,
    ): Promise<EnsureInterventionActionsRepositoryResultV1> {
        parseEnsureInterventionActionsRepositoryCommandV1(command)
        await port.ensure()
        return { contract: ENSURE_INTERVENTION_ACTIONS_REPOSITORY_RESULT_V1, completed: true }
    }
}

export function createCreateInterventionActionHandlerV1(port: InterventionActionsRepositoryPortV1) {
    return async function createInterventionActionV1(
        command: CreateInterventionActionCommandV1 | unknown,
    ): Promise<CreateInterventionActionResultV1> {
        const parsed = parseCreateInterventionActionCommandV1(command)
        await port.create({
            id: parsed.id,
            managerId: parsed.managerId,
            action: parsed.action,
            comment: parsed.comment,
            scoreAtAction: parsed.scoreAtAction,
        })
        return { contract: CREATE_INTERVENTION_ACTION_RESULT_V1, completed: true }
    }
}

export function createListPendingInterventionActionsHandlerV1(port: InterventionActionsRepositoryPortV1) {
    return async function listPendingInterventionActionsV1(
        query: ListPendingInterventionActionsQueryV1 | unknown,
    ): Promise<ListPendingInterventionActionsResultV1> {
        const parsed = parseListPendingInterventionActionsQueryV1(query)
        const items = await port.listPending(parsed.eligibleAtOrBefore)
        return { contract: LIST_PENDING_INTERVENTION_ACTIONS_RESULT_V1, items }
    }
}

export function createSetInterventionOutcomeHandlerV1(port: InterventionActionsRepositoryPortV1) {
    return async function setInterventionOutcomeV1(
        command: SetInterventionOutcomeCommandV1 | unknown,
    ): Promise<SetInterventionOutcomeResultV1> {
        const parsed = parseSetInterventionOutcomeCommandV1(command)
        await port.setOutcome({ id: parsed.id, outcome: parsed.outcome })
        return { contract: SET_INTERVENTION_OUTCOME_RESULT_V1, completed: true }
    }
}

export function createListLatestInterventionActionsHandlerV1(port: InterventionActionsRepositoryPortV1) {
    return async function listLatestInterventionActionsV1(
        query: ListLatestInterventionActionsQueryV1 | unknown,
    ): Promise<ListLatestInterventionActionsResultV1> {
        parseListLatestInterventionActionsQueryV1(query)
        const items = await port.listLatest()
        return { contract: LIST_LATEST_INTERVENTION_ACTIONS_RESULT_V1, items }
    }
}

export function createListInterventionOutcomeCountsHandlerV1(port: InterventionActionsRepositoryPortV1) {
    return async function listInterventionOutcomeCountsV1(
        query: ListInterventionOutcomeCountsQueryV1 | unknown,
    ): Promise<ListInterventionOutcomeCountsResultV1> {
        parseListInterventionOutcomeCountsQueryV1(query)
        const items = await port.listOutcomeCounts()
        return { contract: LIST_INTERVENTION_OUTCOME_COUNTS_RESULT_V1, items }
    }
}

export function createListCompletedInterventionTimesHandlerV1(port: InterventionActionsRepositoryPortV1) {
    return async function listCompletedInterventionTimesV1(
        query: ListCompletedInterventionTimesQueryV1 | unknown,
    ): Promise<ListCompletedInterventionTimesResultV1> {
        parseListCompletedInterventionTimesQueryV1(query)
        const items = await port.listCompletedTimes()
        return { contract: LIST_COMPLETED_INTERVENTION_TIMES_RESULT_V1, items }
    }
}

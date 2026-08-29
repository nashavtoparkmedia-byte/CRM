import {
    ENSURE_MANAGER_HEALTH_REPOSITORY_RESULT_V1,
    LIST_MANAGER_HEALTH_HISTORY_RESULT_V1,
    LIST_MANAGER_HEALTH_SNAPSHOTS_RESULT_V1,
    SAVE_MANAGER_HEALTH_SCORES_RESULT_V1,
    parseEnsureManagerHealthRepositoryCommandV1,
    parseListManagerHealthHistoryQueryV1,
    parseListManagerHealthSnapshotsQueryV1,
    parseSaveManagerHealthScoresCommandV1,
    type EnsureManagerHealthRepositoryCommandV1,
    type EnsureManagerHealthRepositoryResultV1,
    type ListManagerHealthHistoryQueryV1,
    type ListManagerHealthHistoryResultV1,
    type ListManagerHealthSnapshotsQueryV1,
    type ListManagerHealthSnapshotsResultV1,
    type ManagerHealthHistoryPointV1,
    type ManagerHealthScoreInputV1,
    type ManagerHealthSnapshotV1,
    type SaveManagerHealthScoresCommandV1,
    type SaveManagerHealthScoresResultV1,
} from '../../../../contracts/operations-observability/v1'

export interface ManagerHealthRepositoryPortV1 {
    ensure(): Promise<void>
    listSnapshots(): Promise<ManagerHealthSnapshotV1[]>
    saveScores(items: ManagerHealthScoreInputV1[]): Promise<void>
    listHistory(managerIds: string[], periodDays: number): Promise<ManagerHealthHistoryPointV1[]>
}

export function createEnsureManagerHealthRepositoryHandlerV1(port: ManagerHealthRepositoryPortV1) {
    return async function ensureManagerHealthRepositoryV1(
        command: EnsureManagerHealthRepositoryCommandV1 | unknown,
    ): Promise<EnsureManagerHealthRepositoryResultV1> {
        parseEnsureManagerHealthRepositoryCommandV1(command)
        await port.ensure()
        return { contract: ENSURE_MANAGER_HEALTH_REPOSITORY_RESULT_V1, completed: true }
    }
}

export function createListManagerHealthSnapshotsHandlerV1(port: ManagerHealthRepositoryPortV1) {
    return async function listManagerHealthSnapshotsV1(
        query: ListManagerHealthSnapshotsQueryV1 | unknown,
    ): Promise<ListManagerHealthSnapshotsResultV1> {
        parseListManagerHealthSnapshotsQueryV1(query)
        const items = await port.listSnapshots()
        return { contract: LIST_MANAGER_HEALTH_SNAPSHOTS_RESULT_V1, items }
    }
}

export function createSaveManagerHealthScoresHandlerV1(port: ManagerHealthRepositoryPortV1) {
    return async function saveManagerHealthScoresV1(
        command: SaveManagerHealthScoresCommandV1 | unknown,
    ): Promise<SaveManagerHealthScoresResultV1> {
        const parsed = parseSaveManagerHealthScoresCommandV1(command)
        await port.saveScores(parsed.items)
        return { contract: SAVE_MANAGER_HEALTH_SCORES_RESULT_V1, completed: true }
    }
}

export function createListManagerHealthHistoryHandlerV1(port: ManagerHealthRepositoryPortV1) {
    return async function listManagerHealthHistoryV1(
        query: ListManagerHealthHistoryQueryV1 | unknown,
    ): Promise<ListManagerHealthHistoryResultV1> {
        const parsed = parseListManagerHealthHistoryQueryV1(query)
        const items = await port.listHistory(parsed.managerIds, parsed.periodDays)
        return { contract: LIST_MANAGER_HEALTH_HISTORY_RESULT_V1, items }
    }
}

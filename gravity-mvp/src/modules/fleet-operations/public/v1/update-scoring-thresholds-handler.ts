import {
    UPDATE_SCORING_THRESHOLDS_RESULT_V1,
    parseUpdateScoringThresholdsCommandV1,
    type UpdateScoringThresholdsCommandV1,
    type UpdateScoringThresholdsResultV1,
} from '../../../../contracts/fleet-operations/v1'

export interface UpdateScoringThresholdsPersistencePortV1 {
    upsertThresholds(entries: ReadonlyArray<readonly [string, number]>): Promise<void>
}

export function createUpdateScoringThresholdsHandlerV1(port: UpdateScoringThresholdsPersistencePortV1) {
    return async function updateScoringThresholdsV1(
        command: UpdateScoringThresholdsCommandV1 | unknown,
    ): Promise<UpdateScoringThresholdsResultV1> {
        const parsed = parseUpdateScoringThresholdsCommandV1(command)
        const entries = Object.entries(parsed.thresholds)
        await port.upsertThresholds(entries)
        return {
            contract: UPDATE_SCORING_THRESHOLDS_RESULT_V1,
            updated: entries.length,
        }
    }
}

import {
    GET_AI_INTERN_STATE_RESULT_V1,
    SET_AI_INTERN_STATE_RESULT_V1,
    parseGetAiInternStateQueryV1,
    parseSetAiInternStateCommandV1,
    type GetAiInternStateQueryV1,
    type GetAiInternStateResultV1,
    type SetAiInternStateCommandV1,
    type SetAiInternStateResultV1,
} from '../../../../contracts/calling/v1'

export interface AiInternControlPortV1 {
    getInternEnabled(): Promise<boolean | null>
    setInternEnabled(enabled: boolean): Promise<void>
}

export function createAiInternControlHandlerV1(port: AiInternControlPortV1) {
    return {
        async getState(query: GetAiInternStateQueryV1 | unknown): Promise<GetAiInternStateResultV1> {
            parseGetAiInternStateQueryV1(query)
            return {
                contract: GET_AI_INTERN_STATE_RESULT_V1,
                internEnabled: await port.getInternEnabled(),
            }
        },

        async setState(command: SetAiInternStateCommandV1 | unknown): Promise<SetAiInternStateResultV1> {
            const parsed = parseSetAiInternStateCommandV1(command)
            await port.setInternEnabled(parsed.enabled)
            return { contract: SET_AI_INTERN_STATE_RESULT_V1, saved: true }
        },
    }
}

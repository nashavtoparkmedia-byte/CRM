import {
    CRM_USER_RESULT_V1,
    parseCrmUserQueryV1,
    type CrmUserProjectionV1,
    type CrmUserQueryV1,
    type CrmUserResultV1,
} from '../../../../contracts/identity-access/v1'

export interface CrmUserQueryPortV1 {
    findById(userId: string): Promise<CrmUserProjectionV1 | null>
}

export function createCrmUserQueryHandlerV1(port: CrmUserQueryPortV1) {
    return async function queryCrmUserV1(query: CrmUserQueryV1 | unknown): Promise<CrmUserResultV1> {
        const parsed = parseCrmUserQueryV1(query)
        return {
            contract: CRM_USER_RESULT_V1,
            user: await port.findById(parsed.userId),
        }
    }
}

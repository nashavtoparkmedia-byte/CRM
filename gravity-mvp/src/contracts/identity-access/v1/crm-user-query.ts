export const CRM_USER_QUERY_V1 = 'identity_access.CrmUserQuery.v1' as const
export const CRM_USER_RESULT_V1 = 'identity_access.CrmUserResult.v1' as const

export interface CrmUserQueryV1 {
    contract: typeof CRM_USER_QUERY_V1
    userId: string
}

export interface CrmUserProjectionV1 {
    id: string
    name: string
}

export interface CrmUserResultV1 {
    contract: typeof CRM_USER_RESULT_V1
    user: CrmUserProjectionV1 | null
}

export class CrmUserQueryValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: CrmUserQueryValidationError['code'], message: string) {
        super(message)
        this.name = 'CrmUserQueryValidationError'
        this.code = code
    }
}

function invalid(message: string): never {
    throw new CrmUserQueryValidationError('INVALID_CONTRACT', message)
}

export function parseCrmUserQueryV1(input: unknown): CrmUserQueryV1 {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        invalid('CRM user query must be an object')
    }

    const record = input as Record<string, unknown>
    const unexpected = Object.keys(record).filter((key) => !['contract', 'userId'].includes(key))
    if (unexpected.length > 0) invalid(`unsupported query field(s): ${unexpected.sort().join(', ')}`)

    if (record.contract !== CRM_USER_QUERY_V1) {
        if (typeof record.contract === 'string' && record.contract.startsWith('identity_access.CrmUserQuery.')) {
            throw new CrmUserQueryValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${record.contract}`,
            )
        }
        invalid(`contract must equal ${CRM_USER_QUERY_V1}`)
    }

    if (typeof record.userId !== 'string' || record.userId.trim() === '') {
        invalid('userId must be a non-empty string')
    }

    return record as unknown as CrmUserQueryV1
}

export const CURRENT_USER_QUERY_V1 = 'identity_access.CurrentUserQuery.v1' as const
export const CURRENT_USER_RESULT_V1 = 'identity_access.CurrentUserResult.v1' as const
export const LIST_USER_IDENTITIES_QUERY_V1 = 'identity_access.ListUserIdentitiesQuery.v1' as const
export const LIST_USER_IDENTITIES_RESULT_V1 = 'identity_access.ListUserIdentitiesResult.v1' as const
export const AUTHENTICATE_USER_COMMAND_V1 = 'identity_access.AuthenticateUserCommand.v1' as const
export const AUTHENTICATE_USER_RESULT_V1 = 'identity_access.AuthenticateUserResult.v1' as const
export const END_USER_SESSION_COMMAND_V1 = 'identity_access.EndUserSessionCommand.v1' as const
export const END_USER_SESSION_RESULT_V1 = 'identity_access.EndUserSessionResult.v1' as const

export type UserRoleV1 = 'Менеджер' | 'Руководитель' | 'Администратор'
export type UserStatusV1 = 'Активен' | 'Отключен'

export interface UserIdentityV1 {
    id: string
    firstName: string
    lastName: string
    email?: string
    phone?: string
    role: UserRoleV1
    status: UserStatusV1
    createdAt: string
}

export interface CurrentUserQueryV1 {
    contract: typeof CURRENT_USER_QUERY_V1
}

export interface CurrentUserResultV1 {
    contract: typeof CURRENT_USER_RESULT_V1
    user: UserIdentityV1 | null
}

export interface ListUserIdentitiesQueryV1 {
    contract: typeof LIST_USER_IDENTITIES_QUERY_V1
}

export interface ListUserIdentitiesResultV1 {
    contract: typeof LIST_USER_IDENTITIES_RESULT_V1
    users: UserIdentityV1[]
}

export interface AuthenticateUserCommandV1 {
    contract: typeof AUTHENTICATE_USER_COMMAND_V1
    targetUserId: string
}

export interface AuthenticateUserResultV1 {
    contract: typeof AUTHENTICATE_USER_RESULT_V1
}

export interface EndUserSessionCommandV1 {
    contract: typeof END_USER_SESSION_COMMAND_V1
}

export interface EndUserSessionResultV1 {
    contract: typeof END_USER_SESSION_RESULT_V1
}

export class IdentityContractValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: IdentityContractValidationError['code'], message: string) {
        super(message)
        this.name = 'IdentityContractValidationError'
        this.code = code
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
    throw new IdentityContractValidationError('INVALID_CONTRACT', message)
}

function parseEnvelope<T extends string>(input: unknown, expected: T, prefix: string): { contract: T } {
    if (!isRecord(input)) invalid('contract envelope must be an object')
    const unexpected = Object.keys(input).filter((key) => key !== 'contract')
    if (unexpected.length > 0) invalid(`unsupported contract field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== expected) {
        if (typeof input.contract === 'string' && input.contract.startsWith(prefix)) {
            throw new IdentityContractValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${expected}`)
    }
    return input as { contract: T }
}

export function parseCurrentUserQueryV1(input: unknown): CurrentUserQueryV1 {
    return parseEnvelope(input, CURRENT_USER_QUERY_V1, 'identity_access.CurrentUserQuery.')
}

export function parseListUserIdentitiesQueryV1(input: unknown): ListUserIdentitiesQueryV1 {
    return parseEnvelope(input, LIST_USER_IDENTITIES_QUERY_V1, 'identity_access.ListUserIdentitiesQuery.')
}

export function parseAuthenticateUserCommandV1(input: unknown): AuthenticateUserCommandV1 {
    if (!isRecord(input)) invalid('authenticate command must be an object')
    const unexpected = Object.keys(input).filter((key) => !['contract', 'targetUserId'].includes(key))
    if (unexpected.length > 0) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== AUTHENTICATE_USER_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('identity_access.AuthenticateUserCommand.')) {
            throw new IdentityContractValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${AUTHENTICATE_USER_COMMAND_V1}`)
    }
    if (typeof input.targetUserId !== 'string' || input.targetUserId.trim() === '') {
        invalid('targetUserId must be a non-empty string')
    }
    return input as unknown as AuthenticateUserCommandV1
}

export function parseEndUserSessionCommandV1(input: unknown): EndUserSessionCommandV1 {
    return parseEnvelope(input, END_USER_SESSION_COMMAND_V1, 'identity_access.EndUserSessionCommand.')
}

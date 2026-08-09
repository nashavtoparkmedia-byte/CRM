import {
    AUTHENTICATE_USER_RESULT_V1,
    CURRENT_USER_RESULT_V1,
    END_USER_SESSION_RESULT_V1,
    LIST_USER_IDENTITIES_RESULT_V1,
    parseAuthenticateUserCommandV1,
    parseCurrentUserQueryV1,
    parseEndUserSessionCommandV1,
    parseListUserIdentitiesQueryV1,
    type AuthenticateUserCommandV1,
    type AuthenticateUserResultV1,
    type CurrentUserQueryV1,
    type CurrentUserResultV1,
    type EndUserSessionCommandV1,
    type EndUserSessionResultV1,
    type ListUserIdentitiesQueryV1,
    type ListUserIdentitiesResultV1,
    type UserIdentityV1,
} from '../../../../contracts/identity-access/v1'

export interface IdentityAccessPortV1 {
    getCurrentUser(): Promise<UserIdentityV1 | null>
    listUsers(): Promise<UserIdentityV1[]>
    authenticate(targetUserId: string): Promise<void>
    endSession(): Promise<void>
}

export function createIdentityAccessHandlerV1(port: IdentityAccessPortV1) {
    return {
        async queryCurrentUser(command: CurrentUserQueryV1 | unknown): Promise<CurrentUserResultV1> {
            parseCurrentUserQueryV1(command)
            return {
                contract: CURRENT_USER_RESULT_V1,
                user: await port.getCurrentUser(),
            }
        },

        async listUserIdentities(command: ListUserIdentitiesQueryV1 | unknown): Promise<ListUserIdentitiesResultV1> {
            parseListUserIdentitiesQueryV1(command)
            return {
                contract: LIST_USER_IDENTITIES_RESULT_V1,
                users: await port.listUsers(),
            }
        },

        async authenticateUser(command: AuthenticateUserCommandV1 | unknown): Promise<AuthenticateUserResultV1> {
            const parsed = parseAuthenticateUserCommandV1(command)
            await port.authenticate(parsed.targetUserId)
            return { contract: AUTHENTICATE_USER_RESULT_V1 }
        },

        async endUserSession(command: EndUserSessionCommandV1 | unknown): Promise<EndUserSessionResultV1> {
            parseEndUserSessionCommandV1(command)
            await port.endSession()
            return { contract: END_USER_SESSION_RESULT_V1 }
        },
    }
}

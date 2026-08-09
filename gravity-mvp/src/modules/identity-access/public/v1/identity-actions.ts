'use server'

import type {
    AuthenticateUserCommandV1,
    CurrentUserQueryV1,
    EndUserSessionCommandV1,
    ListUserIdentitiesQueryV1,
} from '../../../../contracts/identity-access/v1'
import { createIdentityAccessHandlerV1 } from './identity-access-handler'
import { legacyUserServicePortV1 } from './legacy-user-service-adapter'

const identityAccessV1 = createIdentityAccessHandlerV1(legacyUserServicePortV1)

export async function queryCurrentUserV1(command: CurrentUserQueryV1 | unknown) {
    return identityAccessV1.queryCurrentUser(command)
}

export async function listUserIdentitiesV1(command: ListUserIdentitiesQueryV1 | unknown) {
    return identityAccessV1.listUserIdentities(command)
}

export async function authenticateUserV1(command: AuthenticateUserCommandV1 | unknown) {
    return identityAccessV1.authenticateUser(command)
}

export async function endUserSessionV1(command: EndUserSessionCommandV1 | unknown) {
    return identityAccessV1.endUserSession(command)
}

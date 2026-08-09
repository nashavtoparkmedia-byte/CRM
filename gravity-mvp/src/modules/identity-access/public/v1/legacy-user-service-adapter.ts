import {
    getCurrentUser,
    getUsers,
    login,
    logout,
    type UserItem,
} from '@/lib/users/user-service'
import type { UserIdentityV1 } from '../../../../contracts/identity-access/v1'
import type { IdentityAccessPortV1 } from './identity-access-handler'

function toUserIdentityV1(user: UserItem): UserIdentityV1 {
    return {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        ...(user.email === undefined ? {} : { email: user.email }),
        ...(user.phone === undefined ? {} : { phone: user.phone }),
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
    }
}

/** Compatibility adapter: current cookie and users.json semantics remain authoritative. */
export const legacyUserServicePortV1: IdentityAccessPortV1 = {
    async getCurrentUser() {
        const user = await getCurrentUser()
        return user === null ? null : toUserIdentityV1(user)
    },
    async listUsers() {
        return (await getUsers()).map(toUserIdentityV1)
    },
    async authenticate(targetUserId) {
        await login(targetUserId)
    },
    async endSession() {
        await logout()
    },
}

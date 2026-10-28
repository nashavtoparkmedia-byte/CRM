import { cookies } from 'next/headers'
import {
    getCurrentUser,
    getUsers,
    login,
    logout,
    type UserItem,
} from '@/lib/users/user-service'
import type { UserIdentityV1 } from '../../../../contracts/identity-access/v1'
import type { IdentityAccessPortV1 } from './identity-access-handler'
import { MOBILE_SESSION_COOKIE } from './mobile-session-credentials'
import { resolveRequestOperatorV1 } from './mobile-session-operator'

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

/**
 * Compatibility adapter.
 *
 * Without a mobile session cookie the legacy cookie and users.json semantics
 * remain authoritative, delegated unchanged to the frozen user service.
 *
 * BR-4: with a mobile session cookie, the verified signed session is the only
 * authority. Its operator is the current user, choosing another identity is
 * refused (changing operator means a logout and a new mobile login), and ending
 * the session ends the mobile session itself. A session cookie that grants
 * nothing yields no user and no identity change.
 */
export const legacyUserServicePortV1: IdentityAccessPortV1 = {
    async getCurrentUser() {
        const operator = await resolveRequestOperatorV1()
        if (operator.kind === 'mobile_session_refused') return null
        if (operator.kind === 'mobile_session') {
            const user = (await getUsers()).find((candidate) => candidate.id === operator.operatorId)
            return user === undefined ? null : toUserIdentityV1(user)
        }
        const user = await getCurrentUser()
        return user === null ? null : toUserIdentityV1(user)
    },
    async listUsers() {
        return (await getUsers()).map(toUserIdentityV1)
    },
    async authenticate(targetUserId) {
        const operator = await resolveRequestOperatorV1()
        if (operator.kind !== 'legacy') {
            if (operator.kind === 'mobile_session' && operator.operatorId === targetUserId) return
            console.warn(
                `[auth] blocked operator switch under a mobile session ` +
                `current=${operator.kind === 'mobile_session' ? operator.operatorId : 'refused-session'} ` +
                `target=${targetUserId}`,
            )
            throw new Error('forbidden')
        }
        await login(targetUserId)
    },
    async endSession() {
        if ((await cookies()).get(MOBILE_SESSION_COOKIE) !== undefined) {
            // Push revocation, the durable logout barrier and both cookies, as
            // the mobile logout has always done.
            const { clearMobileSessionV1 } = await import('./mobile-session-auth')
            await clearMobileSessionV1()
            return
        }
        await logout()
    },
}

'use server'

import fs from 'fs/promises'
import path from 'path'
import { cookies } from 'next/headers'
// Pure user-resolution helpers. Live in a sibling `.js` so the
// unit-tests can require them directly via `node --test`, without a
// TypeScript loader. See `./auth-helpers.js`.
import {
    pickUserById,
    canLogin,
    canManageUsers,
    isValidRole,
    wouldDeleteLastPrivileged,
    wouldDemoteLastPrivileged,
} from './auth-helpers'

const filePath = path.join(process.cwd(), 'src/data/users.json')

export interface UserItem {
    id: string
    firstName: string
    lastName: string
    email?: string
    phone?: string
    role: 'Менеджер' | 'Руководитель' | 'Администратор'
    status: 'Активен' | 'Отключен'
    createdAt: string
}

export async function getUsers(): Promise<UserItem[]> {
    try {
        const data = await fs.readFile(filePath, 'utf-8')
        return JSON.parse(data) as UserItem[]
    } catch { return [] }
}

export async function getCurrentUser(): Promise<UserItem | null> {
    const cookieStore = await cookies()
    const id = cookieStore.get('crm_user_id')?.value

    // Intentionally no fallback user.
    // Anonymous requests must fail closed — every caller is responsible
    // for an explicit `if (!user) return 401` guard. The previous
    // `if (!id) id = 'u3'` fallback let any anonymous request inherit
    // `Руководитель` privileges (see `.claude/knowledge/security_debt.md`).
    //
    // Temporary instrumentation: warn once per call so unexpected
    // anonymous traffic surfaces in dev-server logs after deploy. Drop
    // this log once the next-step `login(userId)` redesign lands and we
    // confirm the auth surface is fully tightened.
    if (!id) {
        console.warn('[auth] anonymous request (no crm_user_id cookie)')
        return null
    }

    const users = await getUsers()
    return (pickUserById(users, id) as UserItem | null)
}

/**
 * Switch the active CRM identity by writing the `crm_user_id` cookie.
 *
 * NOT a real authentication primitive — there is no password / token /
 * proof of identity. The CRM operates in an «internal trusted app»
 * model: anyone with browser access to the deployment can pick an
 * identity from the user list. This action enforces the **minimum**
 * safe boundary on top of that model:
 *
 *   - Anonymous, Администратор, Руководитель → may pick any identity.
 *   - Менеджер → may only re-pick their own id (cookie refresh).
 *
 * Anything else throws `forbidden` so the caller can surface an
 * unmistakable failure. The deny path emits one structured warning
 * line — no stack trace, no telemetry — to make accidental escalation
 * attempts visible in dev/server logs.
 *
 * Full canLogin matrix + rationale lives in `./auth-helpers.js`.
 * Out of scope for this guard: real authentication, signed cookies,
 * user-CRUD endpoints, the anonymous-onboarding path itself.
 */
export async function login(targetUserId: string) {
    const cookieStore = await cookies()
    const currentId = cookieStore.get('crm_user_id')?.value
    const allUsers = await getUsers()
    const currentUser = currentId
        ? (pickUserById(allUsers, currentId) as UserItem | null)
        : null

    const verdict = canLogin({ currentUser, targetUserId, allUsers })
    if (!verdict.allowed) {
        // Structured one-liner — forensic-friendly, greppable, no stack
        // trace. `current=anonymous` when there was no cookie at all,
        // and `current=<id>` when there was. Same for role.
        console.warn(
            `[auth] blocked login escalation ` +
            `current=${currentUser?.id ?? 'anonymous'} ` +
            `role=${currentUser?.role ?? 'anonymous'} ` +
            `target=${targetUserId} ` +
            `reason=${verdict.reason}`,
        )
        throw new Error('forbidden')
    }

    cookieStore.set('crm_user_id', targetUserId, { maxAge: 60 * 60 * 24 * 7 }) // 1 week
}

export async function logout() {
    const cookieStore = await cookies()
    cookieStore.delete('crm_user_id')
}

/**
 * Server-side guard for user-CRUD server actions
 * (`addUser` / `updateUser` / `deleteUser`).
 *
 * Mirrors the `canLogin` guard shape from PR #45: read the cookie,
 * resolve the current user via `pickUserById`, ask the pure
 * `canManageUsers` predicate, on denial emit a structured warning and
 * throw. The `action` argument lands directly in the log line so an
 * operator can grep for «what was the manager trying to do».
 *
 * Policy (matches `app/users/page.tsx` client-side guard):
 *   anonymous     → forbidden
 *   Менеджер      → forbidden
 *   Руководитель  → allowed
 *   Администратор → allowed
 */
async function assertCanManageUsers(action: string) {
    const cookieStore = await cookies()
    const currentId = cookieStore.get('crm_user_id')?.value
    const allUsers = await getUsers()
    const currentUser = currentId
        ? (pickUserById(allUsers, currentId) as UserItem | null)
        : null

    if (!canManageUsers(currentUser)) {
        console.warn(
            `[auth] blocked user-management ` +
            `current=${currentUser?.id ?? 'anonymous'} ` +
            `role=${currentUser?.role ?? 'anonymous'} ` +
            `action=${action}`,
        )
        throw new Error('forbidden')
    }
}

export async function addUser(item: Omit<UserItem, 'id' | 'createdAt'>): Promise<UserItem> {
    await assertCanManageUsers('addUser')

    // Reject roles outside the allowlist before they can pollute
    // users.json. Server actions accept arbitrary JSON from the wire —
    // without this check a request body of `{ role: '__proto__' }`
    // would silently land in the file and break subsequent guards
    // (canManageUsers would see an «unknown role» and deny, which
    // looks like a system bug rather than bad input).
    if (!isValidRole(item.role)) {
        console.warn(
            `[auth] rejected user-management ` +
            `action=addUser ` +
            `reason=invalid_role ` +
            `role=${JSON.stringify(item.role)}`,
        )
        throw new Error('invalid_role')
    }

    const users = await getUsers()
    const id = "u" + (users.length + 1)
    const newItem = { ...item, id, createdAt: new Date().toISOString() }
    users.push(newItem)
    await fs.writeFile(filePath, JSON.stringify(users, null, 2))
    return newItem
}

export async function updateUser(id: string, patch: Partial<Omit<UserItem, 'id'>>): Promise<void> {
    await assertCanManageUsers('updateUser')

    // Same role-allowlist gate as addUser: a patch that touches `role`
    // must pass an allowlist check before it can be written. Patches
    // that leave role untouched skip this.
    if (patch.role !== undefined && !isValidRole(patch.role)) {
        console.warn(
            `[auth] rejected user-management ` +
            `action=updateUser ` +
            `reason=invalid_role ` +
            `role=${JSON.stringify(patch.role)}`,
        )
        throw new Error('invalid_role')
    }

    const users = await getUsers()

    // Operational safety invariant: don't let a role change strip the
    // last privileged operator from the system. Without at least one
    // Администратор or Руководитель the UI is unrecoverable (recovery
    // would require hand-editing users.json on disk).
    if (wouldDemoteLastPrivileged(users, id, patch.role)) {
        console.warn(
            `[auth] rejected user-management ` +
            `action=updateUser ` +
            `reason=last_privileged_demotion ` +
            `target=${id}`,
        )
        throw new Error('last_privileged_demotion')
    }

    const idx = users.findIndex(u => u.id === id)
    if (idx !== -1) {
        users[idx] = { ...users[idx], ...patch }
        await fs.writeFile(filePath, JSON.stringify(users, null, 2))
    }
}

export async function deleteUser(id: string): Promise<void> {
    await assertCanManageUsers('deleteUser')

    const users = await getUsers()

    // Same invariant as updateUser: refuse to delete the last privileged
    // operator. Even if the caller is currently privileged, the world
    // after the delete may have zero privileged operators left.
    if (wouldDeleteLastPrivileged(users, id)) {
        console.warn(
            `[auth] rejected user-management ` +
            `action=deleteUser ` +
            `reason=last_privileged_deletion ` +
            `target=${id}`,
        )
        throw new Error('last_privileged_deletion')
    }

    const filtered = users.filter(u => u.id !== id)
    await fs.writeFile(filePath, JSON.stringify(filtered, null, 2))
}

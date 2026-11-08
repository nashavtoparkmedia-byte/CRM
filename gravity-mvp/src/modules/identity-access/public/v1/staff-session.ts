import { cookies, headers } from 'next/headers'
import {
    endStaffSessionsV1,
    isStaffSessionEnforcementOnV1,
    staffSessionCookieNameV1,
    staffSessionCookieSettingsV1,
    staffSessionLifetimeSecondsV1,
    setStaffPasswordV1,
    staffCredentialStatesV1,
    staffLoginModeV1,
    staffLoginV1,
    staffLogoutV1,
    verifyStaffSessionTokenV1,
    type StaffPasswordChangeRefusalV1,
    type StaffSessionPrincipalV1,
} from '../../application/staff-session-operations'
import { getIntegrationAdminPrincipal } from './integration-admin-auth'
import { LEGACY_UI_IDENTITY_COOKIE_V1, MOBILE_SESSION_COOKIE } from './mobile-session-credentials'

/**
 * Staff Session v1 — the public surface of identity_access
 * (docs/design/staff-session-v1.md v1.3).
 *
 * Consumers take employee authority ONLY from getStaffSessionPrincipalV1().
 * getCurrentUser() still answers the legacy cookie while enforcement is off
 * and is never an authority.
 */

export type { StaffSessionPrincipalV1 } from '../../application/staff-session-operations'

/** The staff session cookie's name, for the request boundary. */
export function staffSessionCookieNameForRequestV1(): string {
    return staffSessionCookieNameV1()
}

/** Whether browser-lane enforcement is on (YOKO_STAFF_SESSION_ENFORCE=on). */
export function isStaffSessionEnforcedForRequestV1(): boolean {
    return isStaffSessionEnforcementOnV1()
}

/**
 * The verified employee of this request, or null.
 *
 * Null for: no staff cookie; a cookie that does not verify (forged, expired,
 * wrong audience or version, global or personal epoch moved, credential
 * revoked, registry record missing, disabled, re-created or a role the
 * registry no longer has); a request that also carries a mobile session; and
 * a store or registry that cannot be read (R3; the proxy answers those 503).
 * The role is the registry's, read now. Nothing client-held is an input:
 * crm_user_id, headers, bodies and query parameters never select or change it.
 */
export async function getStaffSessionPrincipalV1(): Promise<StaffSessionPrincipalV1 | null> {
    const store = await cookies()
    if (store.get(MOBILE_SESSION_COOKIE) !== undefined) return null
    const verified = await verifyStaffSessionTokenV1(store.get(staffSessionCookieNameV1())?.value)
    return verified.kind === 'valid' ? verified.principal : null
}

/** What `/login` should ask for. Non-secret. */
export async function getStaffLoginModeV1(): Promise<'password' | 'legacy' | 'unavailable'> {
    return staffLoginModeV1()
}

function legacyUiCookieOptions(maxAge: number) {
    return {
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax' as const,
        path: '/',
        maxAge,
    }
}

export type StaffLoginFailureV1 = 'refused' | 'throttled' | 'busy' | 'unavailable' | 'session_active'

/**
 * Password login for one employee. On success the signed staff cookie is set
 * and crm_user_id is derived from it for the UI (the proxy rewrite makes it
 * authoritative for every reader). Every refusal of the credential itself is
 * the same `refused`.
 */
export async function establishStaffSessionV1(userId: unknown, password: unknown): Promise<{ ok: true } | { ok: false, reason: StaffLoginFailureV1 }> {
    const store = await cookies()
    if (store.get(MOBILE_SESSION_COOKIE) !== undefined) return { ok: false, reason: 'session_active' }
    const requestHeaders = await headers()
    // X-Real-IP is set by the nginx edge; without the edge there is no source key.
    const source = requestHeaders.get('x-real-ip')?.trim().slice(0, 64) || null
    const result = await staffLoginV1({ userId, password, source })
    if (!result.ok) return result
    store.set(staffSessionCookieNameV1(), result.token, staffSessionCookieSettingsV1())
    store.set(LEGACY_UI_IDENTITY_COOKIE_V1, result.principal.userId, legacyUiCookieOptions(staffSessionLifetimeSecondsV1()))
    return { ok: true }
}

/**
 * Logout: every session of this employee ends server-side, and both cookies
 * are cleared. An unverifiable store still clears the cookies but reports it.
 */
export async function endStaffSessionV1(): Promise<'ended' | 'no_session' | 'unverifiable'> {
    const store = await cookies()
    const outcome = await staffLogoutV1(store.get(staffSessionCookieNameV1())?.value).catch(() => 'unverifiable' as const)
    store.set(staffSessionCookieNameV1(), '', staffSessionCookieSettingsV1(true))
    store.set(LEGACY_UI_IDENTITY_COOKIE_V1, '', legacyUiCookieOptions(0))
    return outcome
}

/** Whether this request carries a staff cookie at all (verified or not). */
export async function hasStaffSessionCookieV1(): Promise<boolean> {
    return (await cookies()).get(staffSessionCookieNameV1()) !== undefined
}

/**
 * Set or reset a password as the request's actor: the verified employee, or,
 * only when there is none, the integration-admin session (bootstrap).
 */
export async function setStaffPasswordForRequestV1(
    targetUserId: unknown,
    newPassword: unknown,
    currentPassword?: unknown,
): Promise<{ ok: true } | { ok: false, reason: StaffPasswordChangeRefusalV1 }> {
    if (typeof targetUserId !== 'string') return { ok: false, reason: 'unknown_or_inactive_user' }
    const principal = await getStaffSessionPrincipalV1()
    if (principal !== null) {
        return setStaffPasswordV1({ actor: { kind: 'staff', principal }, targetUserId, newPassword, currentPassword })
    }
    if (await hasStaffSessionCookieV1()) return { ok: false, reason: 'forbidden' }
    if (await getIntegrationAdminPrincipal() === null) return { ok: false, reason: 'forbidden' }
    return setStaffPasswordV1({ actor: { kind: 'integration_admin' }, targetUserId, newPassword })
}

/** «Завершить сеансы» for an employee, by an Администратор or by the employee themself. */
export async function endStaffSessionsForRequestV1(targetUserId: unknown): Promise<'ended' | 'no_credential' | 'forbidden'> {
    if (typeof targetUserId !== 'string') return 'forbidden'
    const principal = await getStaffSessionPrincipalV1()
    if (principal === null) return 'forbidden'
    return endStaffSessionsV1(principal, targetUserId)
}

/**
 * Who has a password, for `/users`: an Администратор under a Staff Session,
 * or the integration-admin session while it bootstraps. Null otherwise.
 */
export async function staffCredentialStatesForRequestV1(): Promise<Record<string, 'live' | 'revoked'> | null> {
    // Dormant or refusing lane: nothing to show, so `/users` looks as before.
    if ((await staffLoginModeV1()) !== 'password') return null
    const principal = await getStaffSessionPrincipalV1()
    const allowed = principal !== null
        ? principal.role === 'Администратор'
        : !(await hasStaffSessionCookieV1()) && (await getIntegrationAdminPrincipal()) !== null
    if (!allowed) return null
    try {
        return await staffCredentialStatesV1()
    } catch {
        return null
    }
}

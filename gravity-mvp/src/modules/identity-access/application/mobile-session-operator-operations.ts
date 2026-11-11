import { cookies } from 'next/headers'
import { prismaMobileSessionBarrierV1 } from '../internal/mobile-session-barrier'
import { staffCredentialLivenessV1, staffSessionCookieNameV1, verifyStaffSessionTokenV1 } from './staff-session-operations'
import { UNSTABLE_DEVICE_ID_V1 } from '../public/v1/mobile-push-registration-handler'
import {
    LEGACY_UI_IDENTITY_COOKIE_V1,
    MOBILE_SESSION_COOKIE,
    mobileSessionBarrierEntryV1,
    resolveEffectiveOperatorV1,
    type MobileSessionPrincipalV1,
} from '../public/v1/mobile-session-credentials'

/**
 * The operator a request acts as (BR-4).
 *
 * `mobile_session` is the verified, not logged-out signed session whose
 * employee's own credential still backs it: its operator
 * is the actor for every protected effect of the request, and no cookie, UI
 * selection or client-supplied id overrides it. `mobile_session_refused` means
 * a session cookie is present but does not grant anything; the request then has
 * no operator. It carries `unverifiable` when the refusal is only because the
 * logout barrier could not be read: the session may well be live, so callers
 * that would otherwise end it should answer that the service is unavailable.
 * `legacy` is the browser lane without a session cookie, whose `crm_user_id`
 * semantics are unchanged.
 *
 * Staff Session v1 joins the same resolution, never beside it: `staff_session`
 * is a verified employee session (docs/design/staff-session-v1.md §4.5) whose
 * employee is the operator; `staff_session_refused` is a staff cookie that
 * grants nothing, `unverifiable` when only the store or the registry could not
 * be read. A request carrying both a mobile and a staff session has no
 * operator (`mobile_session_refused`).
 */
export type RequestOperatorV1 =
    | { kind: 'mobile_session', operatorId: string }
    | { kind: 'mobile_session_refused', unverifiable?: true }
    | { kind: 'staff_session', operatorId: string }
    | { kind: 'staff_session_refused', unverifiable?: true }
    | { kind: 'legacy', operatorId: string | null }

/**
 * The logout barrier's answer for a cryptographically valid session.
 *
 * Fails closed. A session without an instance id (issued before Mobile Push v1)
 * or on the shared unstable device id has no barrier logout could write, so it
 * counts as barred; a barrier that cannot be read is `unreadable`, which is
 * refused too, but kept apart from a logout.
 */
async function mobileSessionBarrierStateV1(principal: MobileSessionPrincipalV1): Promise<'open' | 'barred' | 'unreadable'> {
    const barrierEntry = mobileSessionBarrierEntryV1(principal)
    if (barrierEntry === null || principal.deviceId === UNSTABLE_DEVICE_ID_V1) return 'barred'
    try {
        return (await prismaMobileSessionBarrierV1.isBarred(principal.deviceId, barrierEntry)) ? 'barred' : 'open'
    } catch (error) {
        console.error('[mobile-auth] logout barrier unreadable; refusing the session:', error instanceof Error ? error.name : 'unknown')
        return 'unreadable'
    }
}

/**
 * Whether a cryptographically valid session must still be refused: it was
 * logged out (its barrier entry is recorded), logout could never bar it, or the
 * barrier cannot be read.
 */
export async function isMobileSessionLoggedOutV1(principal: MobileSessionPrincipalV1): Promise<boolean> {
    return (await mobileSessionBarrierStateV1(principal)) !== 'open'
}

/** Resolve from explicit cookie values: the request boundary has no `cookies()`. */
export async function resolveCookieOperatorV1(
    sessionCookie: string | undefined,
    legacyCookie: string | undefined,
    staffCookie?: string | undefined,
): Promise<RequestOperatorV1> {
    if (sessionCookie !== undefined && staffCookie !== undefined) {
        console.warn('[auth] a mobile and a staff session in one request; no operator')
        return { kind: 'mobile_session_refused' }
    }
    if (staffCookie !== undefined) {
        const verified = await verifyStaffSessionTokenV1(staffCookie)
        if (verified.kind === 'valid') return { kind: 'staff_session', operatorId: verified.principal.userId }
        return verified.kind === 'unverifiable'
            ? { kind: 'staff_session_refused', unverifiable: true }
            : { kind: 'staff_session_refused' }
    }
    const resolution = resolveEffectiveOperatorV1({ sessionCookie, legacyCookie })
    if (resolution.kind === 'legacy') return { kind: 'legacy', operatorId: resolution.operatorId }
    if (resolution.kind === 'mobile_session_refused') return { kind: 'mobile_session_refused' }
    const barrier = await mobileSessionBarrierStateV1(resolution.principal)
    if (barrier === 'unreadable') return { kind: 'mobile_session_refused', unverifiable: true }
    if (barrier === 'barred') return { kind: 'mobile_session_refused' }
    // The session follows the employee (docs/design/mobile-personal-signin-v1.md
    // §2.3): disabled, re-created, reset, revoked or logged out in the browser
    // ends it on this very request, however long the phone was offline.
    const liveness = await staffCredentialLivenessV1(resolution.principal.runtimeOperatorId, resolution.principal.staffEpoch)
    if (liveness === 'unverifiable') return { kind: 'mobile_session_refused', unverifiable: true }
    if (liveness === 'ended') return { kind: 'mobile_session_refused' }
    return { kind: 'mobile_session', operatorId: resolution.operatorId }
}

/** Resolve the current request's operator from its cookies. */
export async function resolveRequestOperatorV1(): Promise<RequestOperatorV1> {
    const store = await cookies()
    return resolveCookieOperatorV1(
        store.get(MOBILE_SESSION_COOKIE)?.value,
        store.get(LEGACY_UI_IDENTITY_COOKIE_V1)?.value,
        store.get(staffSessionCookieNameV1())?.value,
    )
}

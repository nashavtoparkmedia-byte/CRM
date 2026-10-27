import { cookies } from 'next/headers'
import { prismaMobileSessionBarrierV1 } from '../internal/mobile-session-barrier'
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
 * `mobile_session` is the verified, not logged-out signed session: its operator
 * is the actor for every protected effect of the request, and no cookie, UI
 * selection or client-supplied id overrides it. `mobile_session_refused` means
 * a session cookie is present but does not grant anything; the request then has
 * no operator. `legacy` is the browser lane without a session cookie, whose
 * `crm_user_id` semantics are unchanged.
 */
export type RequestOperatorV1 =
    | { kind: 'mobile_session', operatorId: string }
    | { kind: 'mobile_session_refused' }
    | { kind: 'legacy', operatorId: string | null }

/**
 * Whether a cryptographically valid session must still be refused: it was
 * logged out (its barrier entry is recorded), or logout could never bar it.
 *
 * Fails closed. A session without an instance id (issued before Mobile Push v1)
 * or on the shared unstable device id has no barrier logout could write, and a
 * barrier that cannot be read is treated as written.
 */
export async function isMobileSessionLoggedOutV1(principal: MobileSessionPrincipalV1): Promise<boolean> {
    const barrierEntry = mobileSessionBarrierEntryV1(principal)
    if (barrierEntry === null || principal.deviceId === UNSTABLE_DEVICE_ID_V1) return true
    try {
        return await prismaMobileSessionBarrierV1.isBarred(principal.deviceId, barrierEntry)
    } catch (error) {
        console.error('[mobile-auth] logout barrier unreadable; refusing the session:', error instanceof Error ? error.name : 'unknown')
        return true
    }
}

/** Resolve from explicit cookie values: the request boundary has no `cookies()`. */
export async function resolveCookieOperatorV1(
    sessionCookie: string | undefined,
    legacyCookie: string | undefined,
): Promise<RequestOperatorV1> {
    const resolution = resolveEffectiveOperatorV1({ sessionCookie, legacyCookie })
    if (resolution.kind === 'legacy') return { kind: 'legacy', operatorId: resolution.operatorId }
    if (resolution.kind === 'mobile_session_refused') return { kind: 'mobile_session_refused' }
    if (await isMobileSessionLoggedOutV1(resolution.principal)) return { kind: 'mobile_session_refused' }
    return { kind: 'mobile_session', operatorId: resolution.operatorId }
}

/** Resolve the current request's operator from its cookies. */
export async function resolveRequestOperatorV1(): Promise<RequestOperatorV1> {
    const store = await cookies()
    return resolveCookieOperatorV1(
        store.get(MOBILE_SESSION_COOKIE)?.value,
        store.get(LEGACY_UI_IDENTITY_COOKIE_V1)?.value,
    )
}

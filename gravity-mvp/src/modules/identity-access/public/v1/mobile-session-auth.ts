import { cookies, headers } from 'next/headers'
import {
    MOBILE_SESSION_COOKIE,
    MOBILE_SESSION_TTL_SECONDS,
    isMobileSessionSigningConfigured,
    issueMobileSession,
    mobileSessionBarrierEntryV1,
    mobileSessionBindingIdV1,
    isSafeDeviceId,
    isSafeRuntimeOperatorId,
    verifyMobileSession,
    type MobileSessionPrincipalV1,
} from './mobile-session-credentials'
import { UNSTABLE_DEVICE_ID_V1 } from './mobile-push-registration-handler'
import { resolveCookieOperatorV1, resolveRequestOperatorV1 } from './mobile-session-operator'
import {
    clearStaffCredentialFailuresV1,
    recordMobileStaffEventV1,
    staffLaneStateV1,
    verifyStaffCredentialV1,
} from '../../application/staff-session-operations'

/**
 * User-Agent fragment the Android shell appends to identify its lane.
 *
 * Declared in both this module and `gravity-mvp/src/proxy.ts`, which cannot
 * import from here: the proxy is compiled for the request boundary and must
 * stay free of server-action modules. The two are kept in step by
 * `mobile-shell-lane-source.test.ts`, which fails if they drift.
 */
export const MOBILE_SHELL_UA_TOKEN = 'YokoShell/'

/**
 * Cookie-facing half of the mobile session.
 *
 * The signed cookie is the only thing this lane trusts. `crm_user_id` is still
 * written, because the existing Messenger UI reads it from `document.cookie`
 * for the "assigned to me" filter and for auto-assign on first reply, and the
 * stage requires the same interface, not a degraded one. It is written as a
 * DERIVED value: every request that passes through the mobile gate re-writes
 * it from the verified token, so a tampered value is corrected rather than
 * believed, and nothing in this module ever reads it back for a decision.
 */

const LEGACY_UI_IDENTITY_COOKIE = 'crm_user_id'

/**
 * Why a mobile sign-in did not happen. `refused` covers every credential
 * failure (unknown id, wrong password, disabled, no credential) with one
 * answer; `throttled` is shown with the same text by the sign-in page.
 */
export type MobileLoginFailure =
    | 'refused'
    | 'throttled'
    | 'busy'
    | 'unavailable'
    | 'invalid_device'
    | 'issue_failed'
    | 'session_active'

/** Whether the mobile sign-in can run: the staff lane is ready (secret valid, registry located). */
export async function isMobileLaneConfigured(): Promise<boolean> {
    if (!isMobileSessionSigningConfigured()) return false
    return (await staffLaneStateV1().catch(() => ({ kind: 'refused' } as const))).kind === 'ready'
}

/**
 * True when the request comes from the Android shell, session or not.
 *
 * This deliberately does NOT consult the session. Every window in which the
 * session is absent — before login, after the twelve-hour expiry, after a
 * revocation-epoch bump, after the credential is rotated — is a window in which
 * the shell is still running and still mounting the browser softphone. Keying
 * the telephony denial on the session would open exactly those windows, and the
 * worst of them hands out a SIP password to a device whose access was just
 * revoked.
 *
 * The marker is client-supplied and needs no integrity: it only ever selects a
 * stricter path. Removing it makes the caller an ordinary browser, which is
 * what it already was.
 */
export async function isMobileShellClientV1(): Promise<boolean> {
    const userAgent = (await headers()).get('user-agent') ?? ''
    return userAgent.includes(MOBILE_SHELL_UA_TOKEN)
}

export async function getMobileSessionPrincipalV1(): Promise<MobileSessionPrincipalV1 | null> {
    const cookieStore = await cookies()
    return verifyMobileSession(cookieStore.get(MOBILE_SESSION_COOKIE)?.value)
}

/**
 * Whether the request holds a session the request boundary accepts.
 *
 * This is the boundary's own predicate (BR-4), not the signature check alone. A
 * signature-valid session that was logged out, or whose logout barrier cannot be
 * read, is refused by the boundary and sent to the login screen; if the login
 * screen counted it as a session it would send the shell straight back, and the
 * two would redirect into each other until the token expired.
 */
export async function hasMobileSessionV1(): Promise<boolean> {
    return (await resolveRequestOperatorV1()).kind === 'mobile_session'
}

function sessionCookieOptions(maxAge: number) {
    return {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        // `lax`, not `strict`: a notification tap is a top-level navigation the
        // shell starts itself, and `lax` is the setting that is unambiguously
        // sent for one on every WebView version. It still refuses the cookie on
        // cross-site subresource and POST, which is the property that matters.
        sameSite: 'lax' as const,
        path: '/',
        maxAge,
    }
}

/**
 * Establish a mobile session for the employee whose own Staff Session password
 * verifies (docs/design/mobile-personal-signin-v1.md §2.1). The operator IS
 * that employee: `userId` is only the id the password is checked against.
 *
 * The same verifier, scrypt slot, throttle keys and uniform `refused` as the
 * browser `/login`. There is no shared credential and no fallback: a staff
 * lane that is not ready answers `unavailable`.
 */
export async function establishMobileSessionV1(
    userId: unknown,
    suppliedPassword: unknown,
    deviceId: unknown,
): Promise<{ ok: true, principal: MobileSessionPrincipalV1 } | { ok: false, reason: MobileLoginFailure }> {
    if (!isMobileSessionSigningConfigured()) return { ok: false, reason: 'unavailable' }
    // The shared fallback id cannot carry a logout barrier, so a session on it
    // could never be ended server-side (BR-4).
    if (!isSafeDeviceId(deviceId) || deviceId === UNSTABLE_DEVICE_ID_V1) return { ok: false, reason: 'invalid_device' }

    // Changing the operator means ending this session first (BR-4): a second
    // login on top of a live one would be an operator switch without a logout.
    if ((await resolveRequestOperatorV1()).kind === 'mobile_session') return { ok: false, reason: 'session_active' }

    // X-Real-IP is set by the nginx edge; without the edge there is no source key.
    const source = (await headers()).get('x-real-ip')?.trim().slice(0, 64) || null
    const checked = await verifyStaffCredentialV1(
        { userId: isSafeRuntimeOperatorId(userId) ? userId : '', password: suppliedPassword, source },
        'mobile',
    )
    if (!checked.ok) return { ok: false, reason: checked.reason }

    const token = issueMobileSession(checked.record.id, deviceId, checked.credential.sessionEpoch)
    if (!token) return { ok: false, reason: 'issue_failed' }

    const principal = verifyMobileSession(token)
    if (!principal) return { ok: false, reason: 'issue_failed' }
    clearStaffCredentialFailuresV1(checked.throttleKeys)

    const cookieStore = await cookies()
    cookieStore.set(MOBILE_SESSION_COOKIE, token, sessionCookieOptions(MOBILE_SESSION_TTL_SECONDS))
    await writeDerivedUiIdentityCookie(principal)
    await recordMobileStaffEventV1(principal.runtimeOperatorId, 'login', mobileSessionBindingIdV1(principal))
    return { ok: true, principal }
}

/**
 * Re-write the legacy UI identity cookie from the verified session.
 *
 * Deliberately mirrors the session lifetime so the two cannot drift apart: the
 * UI value expires exactly when the thing that justified it expires.
 */
export async function writeDerivedUiIdentityCookie(principal: MobileSessionPrincipalV1): Promise<void> {
    const cookieStore = await cookies()
    const remaining = Math.max(
        0,
        principal.expiresAtSeconds - Math.floor(Date.now() / 1000),
    )
    cookieStore.set(LEGACY_UI_IDENTITY_COOKIE, principal.runtimeOperatorId, {
        // Not httpOnly: the existing Messenger reads this from document.cookie.
        // It carries no authority, so readability costs nothing.
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: remaining,
    })
}

/**
 * Revoke the device's push registration and record this session in the
 * device's durable logout barrier. True when that write committed.
 *
 * Mobile Push v1: a logged-out device must stop receiving push, so its
 * registration is revoked (and its token released) while the session that
 * proves which device it is still exists. The session that logs out is
 * recorded in the device's durable barrier, so a registration request proven
 * by this same session can never re-activate the device, however long it was
 * in flight; a device that never registered gets a tombstone carrying that
 * barrier.
 */
async function recordMobileLogoutBarrier(principal: MobileSessionPrincipalV1): Promise<boolean> {
    try {
        const { revokeMobilePushDeviceForLogoutV1 } = await import('../../application/mobile-push-registration-operations')
        await revokeMobilePushDeviceForLogoutV1({
            principal,
            sessionBindingId: mobileSessionBindingIdV1(principal),
            barrierEntry: mobileSessionBarrierEntryV1(principal),
        })
    } catch (error) {
        console.error('[mobile-auth] push registration revocation on logout failed:', error instanceof Error ? error.name : 'unknown')
        return false
    }
    // The audit never decides the logout: it only records one that happened.
    await recordMobileStaffEventV1(principal.runtimeOperatorId, 'logout', mobileSessionBindingIdV1(principal))
    return true
}

async function clearMobileSessionCookies(): Promise<void> {
    const cookieStore = await cookies()
    cookieStore.set(MOBILE_SESSION_COOKIE, '', sessionCookieOptions(0))
    cookieStore.set(LEGACY_UI_IDENTITY_COOKIE, '', {
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
    })
}

/** Log out: drop the signed session and the value derived from it. */
export async function clearMobileSessionV1(): Promise<void> {
    // Logging out never depends on the barrier write: if it fails, the session
    // is still cleared and the registration stays bounded by the session's own
    // expiry.
    const principal = await getMobileSessionPrincipalV1()
    if (principal) await recordMobileLogoutBarrier(principal)
    await clearMobileSessionCookies()
}

/**
 * What a native logout request achieved (`POST /api/mobile/session/logout`).
 *
 * - `logged_out`: the presented session was live and its barrier entry is now
 *   recorded; no later request can use it.
 * - `no_session`: nothing to end — no session cookie, or one the boundary
 *   already refuses for good (bad signature, expired, an older revocation
 *   epoch, already logged out, or a session logout could never bar).
 * - `unavailable`: the session may still be live — its barrier could not be
 *   read, or the barrier write failed.
 */
export type MobileSessionLogoutOutcomeV1 = 'logged_out' | 'no_session' | 'unavailable'

/**
 * End the mobile session this request presents, for a caller that is not a
 * page (the Android shell's reset). Identity Access decides everything from the
 * `yoko_mobile_session` cookie alone: no body, header, `crm_user_id` or staff
 * cookie selects anything, and this never authenticates — it sets no session,
 * switches no operator and leaves a Staff Session cookie untouched.
 *
 * Only a session the request boundary itself would accept (BR-4) is ended, so
 * the barrier entry written is exactly that session's. A session the boundary
 * refuses, or a barrier that cannot be read, leaves everything as it was: no
 * row is written and no cookie is set.
 */
export async function endMobileSessionForRequestV1(): Promise<MobileSessionLogoutOutcomeV1> {
    const sessionCookie = (await cookies()).get(MOBILE_SESSION_COOKIE)?.value
    if (sessionCookie === undefined) return 'no_session'
    const principal = verifyMobileSession(sessionCookie)
    if (!principal) return 'no_session'
    // The boundary's own predicate over this cookie alone: a co-present staff
    // cookie or crm_user_id must neither block nor redirect the logout.
    const operator = await resolveCookieOperatorV1(sessionCookie, undefined)
    if (operator.kind === 'mobile_session_refused') return operator.unverifiable ? 'unavailable' : 'no_session'
    if (operator.kind !== 'mobile_session' || operator.operatorId !== principal.runtimeOperatorId) return 'no_session'
    const recorded = await recordMobileLogoutBarrier(principal)
    await clearMobileSessionCookies()
    return recorded ? 'logged_out' : 'unavailable'
}

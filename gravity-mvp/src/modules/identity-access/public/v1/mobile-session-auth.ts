import { cookies, headers } from 'next/headers'
import {
    MOBILE_SESSION_COOKIE,
    MOBILE_SESSION_TTL_SECONDS,
    getMobileAccessCredentialConfig,
    issueMobileSession,
    isSafeDeviceId,
    isSafeRuntimeOperatorId,
    verifyMobileAccessCredentials,
    verifyMobileSession,
    type MobileSessionPrincipalV1,
} from './mobile-session-credentials'
import { listUserIdentitiesV1 } from './user-directory'

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

export type MobileLoginFailure =
    | 'not_configured'
    | 'invalid_credentials'
    | 'unknown_operator'
    | 'inactive_operator'
    | 'invalid_device'
    | 'issue_failed'

export function isMobileLaneConfigured(): boolean {
    return getMobileAccessCredentialConfig() !== null
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

export async function hasMobileSessionV1(): Promise<boolean> {
    return (await getMobileSessionPrincipalV1()) !== null
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
 * Establish a mobile session after proving the provisioned credential.
 *
 * Returns the failure reason rather than throwing, so the login screen can say
 * something true without leaking which half of the credential was wrong: the
 * caller maps every credential-shaped failure to one message.
 */
export async function establishMobileSessionV1(
    suppliedUsername: unknown,
    suppliedPassword: unknown,
    runtimeOperatorId: unknown,
    deviceId: unknown,
): Promise<{ ok: true, principal: MobileSessionPrincipalV1 } | { ok: false, reason: MobileLoginFailure }> {
    if (!isMobileLaneConfigured()) return { ok: false, reason: 'not_configured' }
    if (!isSafeDeviceId(deviceId)) return { ok: false, reason: 'invalid_device' }
    if (!isSafeRuntimeOperatorId(runtimeOperatorId)) return { ok: false, reason: 'unknown_operator' }

    if (!verifyMobileAccessCredentials(suppliedUsername, suppliedPassword)) {
        console.warn('[mobile-auth] denied mobile session: credential not proven')
        return { ok: false, reason: 'invalid_credentials' }
    }

    // The operator must exist and be enabled. Resolved through the context's
    // own versioned directory rather than the legacy user service, which stays
    // isolated behind its compatibility adapter. `getCurrentUser` does not
    // check status today; the mobile lane does, so a disabled operator cannot
    // keep a phone working.
    const operator = (await listUserIdentitiesV1()).find((user) => user.id === runtimeOperatorId)
    if (!operator) return { ok: false, reason: 'unknown_operator' }
    if (operator.status !== 'Активен') return { ok: false, reason: 'inactive_operator' }

    const token = issueMobileSession(runtimeOperatorId, deviceId)
    if (!token) return { ok: false, reason: 'issue_failed' }

    const principal = verifyMobileSession(token)
    if (!principal) return { ok: false, reason: 'issue_failed' }

    const cookieStore = await cookies()
    cookieStore.set(MOBILE_SESSION_COOKIE, token, sessionCookieOptions(MOBILE_SESSION_TTL_SECONDS))
    await writeDerivedUiIdentityCookie(principal)
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

/** Log out: drop the signed session and the value derived from it. */
export async function clearMobileSessionV1(): Promise<void> {
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

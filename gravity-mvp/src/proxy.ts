import { NextResponse, type NextRequest } from 'next/server'
import {
    LEGACY_UI_IDENTITY_COOKIE_V1,
    MOBILE_SESSION_COOKIE,
    withLegacyUiIdentityCookieV1,
} from '@/modules/identity-access/public/v1/mobile-session-credentials'
import { resolveCookieOperatorV1 } from '@/modules/identity-access/public/v1/mobile-session-operator'

/**
 * Request boundary for the application.
 *
 * Two unrelated jobs live here because Next gives one proxy per app.
 *
 * 1. Debug database routes are never part of the public HTTP surface. Keeping
 *    this negative gate in the application prevents direct-container access
 *    from bypassing the matching Nginx denial.
 *
 * 2. The Android shell lane fails closed. Every request that identifies itself
 *    as the shell must carry a valid mobile session, or it gets the mobile
 *    login screen instead of the CRM.
 *
 * ## Why the shell lane needs a gate here and not in the routes
 *
 * The CRM has no authentication (see CRM_BACKEND_BLOCKER: MOBILE_AUTH_BOUNDARY
 * in docs/mobile/ANDROID_SHELL_STAGE_1.md). Twenty-six of its thirty-one
 * messenger API paths have no caller check at all, `/messages` itself renders
 * for anyone, and two writes are reachable by GET. A gate on the one route the
 * notification tap happens to use protects nothing: the shell would restore a
 * saved `/messages?id=...` on next launch and never pass it, and every send,
 * delete and stream would remain open for the lifetime of the app.
 *
 * Putting the check in the proxy means the shell cannot reach ANY CRM surface
 * without a live session — pages, API routes, server actions, the SSE stream —
 * and that expiry and revocation take effect on the very next request rather
 * than at the next deep link.
 *
 * ## What this does NOT do
 *
 * It does not authenticate the browser lane. A desktop request without a mobile
 * session cookie is untouched and still reaches everything unauthenticated,
 * exactly as before. This narrows the
 * surface the shell adds; it does not close the CRM's own hole, which needs a
 * CRM-wide identity project.
 *
 * ## BR-4: the signed operator is the request's operator
 *
 * A request that carries a valid, not logged-out mobile session acts as that
 * session's signed operator, whatever its User-Agent says. Most of the CRM
 * reads the actor from the unsigned `crm_user_id` cookie, so a
 * Set-Cookie on the response would correct only the NEXT request. Instead, the
 * incoming request is rewritten: its Cookie header goes downstream with exactly
 * one `crm_user_id`, the signed operator. Route handlers, server components
 * and Server Actions of this same request read that value through `cookies()`.
 * A session cookie that is present but grants nothing (tampered, expired,
 * revoked, logged out) sends the request downstream with no `crm_user_id` at
 * all. Without a session cookie, a browser request is passed through as before.
 *
 * When the logout barrier cannot be read (database unavailable) the session is
 * refused all the same, but the shell lane is answered 503 rather than 401/303:
 * the shell treats the login screen as the end of its session and resets the
 * device, and an outage is not a logout.
 *
 * ## Why keying on a client-supplied marker is sound
 *
 * The marker selects a STRICTER path, never a weaker one. An attacker who
 * strips it is treated as an ordinary browser, which is what they already were;
 * they gain nothing they did not have. An attacker who forges it only locks
 * themselves out. So the marker needs no integrity, and the shell sets it as a
 * User-Agent suffix, which survives cookie loss and process death.
 */

/** User-Agent fragment the Android shell appends to identify its lane. */
export const MOBILE_SHELL_UA_TOKEN = 'YokoShell/'

/**
 * A note for anyone tempted to strip the CRM chrome off the sign-in screen by
 * varying the root layout: it does not work. Next does not re-render a root
 * layout on client-side navigation, so a layout that omits SipProvider for the
 * login route leaves the provider missing after the router moves to the
 * messenger, and every component calling useSip throws
 * "useSip must be used inside SipProvider" into the production error boundary.
 * Measured, not assumed. The chrome on the sign-in screen is cosmetic; the
 * provider tree has to stay constant.
 */

/**
 * Paths the shell may reach without a session.
 *
 * Only the mobile login screen and what a browser needs to render it. The
 * login page is also the POST target of its own server action, so the prefix
 * match covers the credential submission.
 */
const SHELL_PUBLIC_PREFIXES = [
    '/login/mobile',
    '/_next/',
    '/favicon.ico',
]

const SERVICE_UNAVAILABLE_PAGE = '<!doctype html><html lang="ru"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><title>YOKO CRM</title></head>'
    + '<body style="font-family:system-ui,sans-serif;color:#0F172A;padding:24px">'
    + '<p style="font-size:15px">CRM временно недоступна. Повторите через несколько секунд.</p></body></html>'

function isShellRequest(request: NextRequest): boolean {
    return (request.headers.get('user-agent') ?? '').includes(MOBILE_SHELL_UA_TOKEN)
}

/**
 * Pass the request downstream with its Cookie header carrying exactly
 * `operatorId` as `crm_user_id`, or no `crm_user_id` when null.
 */
function forwardWithOperator(request: NextRequest, operatorId: string | null): NextResponse {
    const headers = new Headers(request.headers)
    const cookie = withLegacyUiIdentityCookieV1(request.headers.get('cookie'), operatorId)
    if (cookie) headers.set('cookie', cookie)
    else headers.delete('cookie')
    const response = NextResponse.next({ request: { headers } })
    // Keep the browser's copy, which the Messenger reads from document.cookie,
    // in step with the session. Only on reads: a POST may be the Server Action
    // that logs in or out, and its own Set-Cookie must not be contradicted.
    const method = request.method.toUpperCase()
    if (
        operatorId !== null
        && (method === 'GET' || method === 'HEAD')
        && request.cookies.get(LEGACY_UI_IDENTITY_COOKIE_V1)?.value !== operatorId
    ) {
        response.cookies.set(LEGACY_UI_IDENTITY_COOKIE_V1, operatorId, {
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
        })
    }
    return response
}

export async function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl

    if (pathname.startsWith('/api/debug-db')) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const shell = isShellRequest(request)
    const sessionCookie = request.cookies.get(MOBILE_SESSION_COOKIE)?.value

    // The browser lane without a mobile session is deliberately unchanged.
    if (!shell && sessionCookie === undefined) return NextResponse.next()

    const operator = await resolveCookieOperatorV1(
        sessionCookie,
        request.cookies.get(LEGACY_UI_IDENTITY_COOKIE_V1)?.value,
    )
    if (operator.kind === 'mobile_session') return forwardWithOperator(request, operator.operatorId)

    // From here the request has no signed operator: no session at all in the
    // shell lane, or a session cookie that grants nothing in either lane. It
    // never reaches anything with an identity it could choose itself.
    if (!shell || SHELL_PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
        return forwardWithOperator(request, null)
    }

    // The session could not be checked, not found dead: say the service is
    // unavailable, so the shell keeps its session and retries.
    if (operator.kind === 'mobile_session_refused' && operator.unverifiable) {
        const headers = { 'retry-after': '5', 'cache-control': 'no-store' }
        if (pathname.startsWith('/api/')) {
            return NextResponse.json({ error: 'mobile_session_unverifiable' }, { status: 503, headers })
        }
        return new NextResponse(SERVICE_UNAVAILABLE_PAGE, {
            status: 503,
            headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
        })
    }

    // An API caller gets a status it can act on; anything that renders gets the
    // login screen, carrying where it was going so login can finish the journey.
    if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'mobile_session_required' }, { status: 401 })
    }

    const target = `${pathname}${request.nextUrl.search}`
    const login = new URL('/login/mobile', request.url)
    login.searchParams.set('next', target)
    return NextResponse.redirect(login, { status: 303 })
}

export const config = {
    // Everything except the build output the login screen itself needs. The
    // shell lane is only as closed as this matcher is wide.
    matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}

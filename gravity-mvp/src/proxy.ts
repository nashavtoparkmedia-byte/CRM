import { NextResponse, type NextRequest } from 'next/server'
import {
    MOBILE_SESSION_COOKIE,
    verifyMobileSession,
} from '@/modules/identity-access/public/v1/mobile-session-credentials'

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
 * It does not authenticate the browser lane. A desktop request is untouched and
 * still reaches everything unauthenticated, exactly as before. This narrows the
 * surface the shell adds; it does not close the CRM's own hole, which needs a
 * CRM-wide identity project.
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

function isShellRequest(request: NextRequest): boolean {
    return (request.headers.get('user-agent') ?? '').includes(MOBILE_SHELL_UA_TOKEN)
}

function hasValidMobileSession(request: NextRequest): boolean {
    return verifyMobileSession(request.cookies.get(MOBILE_SESSION_COOKIE)?.value) !== null
}

export function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl

    if (pathname.startsWith('/api/debug-db')) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // The browser lane is deliberately unchanged.
    if (!isShellRequest(request)) return NextResponse.next()

    if (SHELL_PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
        return NextResponse.next()
    }

    if (hasValidMobileSession(request)) return NextResponse.next()

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

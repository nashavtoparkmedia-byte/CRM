import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { NextResponse, type NextRequest } from 'next/server'
import {
    LEGACY_UI_IDENTITY_COOKIE_V1,
    MOBILE_SESSION_COOKIE,
    withLegacyUiIdentityCookieV1,
} from '@/modules/identity-access/public/v1/mobile-session-credentials'
import { resolveCookieOperatorV1 } from '@/modules/identity-access/public/v1/mobile-session-operator'
import {
    isStaffSessionEnforcedForRequestV1,
    staffSessionCookieNameForRequestV1,
} from '@/modules/identity-access/public/v1/staff-session'

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
 *
 * ## Staff Session v1: the browser lane joins the same rewrite
 *
 * A browser request with a staff session cookie acts as that session's
 * verified employee exactly as the shell acts as its signed operator: the
 * Cookie header goes downstream with exactly one `crm_user_id`, the employee,
 * or none when the staff cookie grants nothing. When the credential store or
 * the registry cannot be read the request is answered 503, never passed with
 * a client-chosen identity (docs/design/staff-session-v1.md §4.5, R3). Without
 * YOKO_STAFF_SESSION_ENFORCE=on and without a staff cookie, the browser lane is
 * unchanged.
 *
 * ## Enforcement: no personal sign-in, no CRM
 *
 * With YOKO_STAFF_SESSION_ENFORCE=on a browser request without a verified
 * session is refused, not forwarded (docs/design/staff-session-enforce-deny-v1.md).
 * "Without a verified session" covers no cookie, a forged, expired or revoked
 * staff cookie, a refused mobile cookie and a bare `crm_user_id`. Only the exact
 * paths of ENFORCED_SESSIONLESS_ALLOWLIST pass, with no `crm_user_id`. Each
 * entry names the methods it takes and why it may be reached without an
 * employee; a listed machine route still checks its own secret, because being
 * listed is never the gate. A server action carries its id in `Next-Action`
 * and runs on whatever page it is posted to, so a session-less action passes
 * only when the build's own manifest maps that id, for that page, to one of
 * SESSIONLESS_SERVER_ACTIONS. Everything else gets 401 JSON for the API, for
 * every server action and for any method but GET/HEAD; a page read gets a 303
 * to `/login`.
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

/**
 * Exact paths the shell may reach without a live session.
 *
 * The native logout (F-1) must answer 204 for a session that is already dead
 * as well as for a live one, so the route decides, not this gate. It reads the
 * session cookie alone, ends only a session this boundary accepts and never
 * grants an identity; it still receives no `crm_user_id` from here.
 */
const SHELL_PUBLIC_PATHS = new Set([
    '/api/mobile/session/logout',
])

export interface SessionlessAllowlistEntryV1 {
    readonly path: string
    readonly methods: readonly string[]
    readonly reason: string
}

/**
 * The browser-lane paths a request without a verified session may reach while
 * enforcement is on. Exact paths and methods only, never a prefix: a `[name]`
 * segment stands for exactly one path segment of `[A-Za-z0-9_-]{1,128}`, so the
 * segment count is fixed. The build output a page needs (`/_next/static`,
 * `/_next/image`, `/favicon.ico`) never reaches this proxy (see
 * `config.matcher`). A machine route is listed only when the route itself
 * refuses a caller without its secret, also when the secret is not configured.
 * Pinned by src/lib/security/staff-session-enforce-deny.test.ts and
 * scripts/check-public-boundaries.mjs, which also requires each listed route to
 * keep its own gate; a change is a reviewed change.
 */
export const ENFORCED_SESSIONLESS_ALLOWLIST: readonly SessionlessAllowlistEntryV1[] = [
    { path: '/login', methods: ['GET', 'HEAD'], reason: 'staff sign-in page; its sign-in actions are pinned in SESSIONLESS_SERVER_ACTIONS' },
    { path: '/api/mobile/push-registration', methods: ['POST'], reason: 'native Android call without the shell marker; the route requires a live mobile session itself (401 MOBILE_SESSION_REVOKED)' },
    { path: '/api/mobile/session/logout', methods: ['POST'], reason: 'native Android logout (F-1); ends only a session the boundary accepts, answers 204 otherwise and never authenticates' },
    { path: '/api/webhooks/bot', methods: ['POST'], reason: 'tg-bot over the internal network; the route requires x-bot-signature = BOT_CRM_SECRET' },
    { path: '/api/webhook/telegram', methods: ['POST'], reason: 'tg-bot ingress over the internal network; the route requires x-bot-signature = BOT_CRM_SECRET and refuses when it is unset' },
    { path: '/api/webhooks/max', methods: ['POST'], reason: 'max-web-scraper over the internal network; the route requires MAX_SCRAPER_WEBHOOK_SECRET (constant-time, refuses when unset)' },
    { path: '/api/webhook/max/reaction', methods: ['POST'], reason: 'max-web-scraper reactions; the route requires MAX_SCRAPER_WEBHOOK_SECRET (constant-time, refuses when unset)' },
    { path: '/api/ai-calls/sessions/[id]/state', methods: ['POST'], reason: 'AI-call audio bridge; the route requires X-Bridge-Token = BRIDGE_SHARED_TOKEN (strong secret, constant-time, refuses when unset)' },
    { path: '/api/ai-calls/sessions/[id]/transcript-item', methods: ['POST'], reason: 'AI-call audio bridge; the route requires X-Bridge-Token = BRIDGE_SHARED_TOKEN (strong secret, constant-time, refuses when unset)' },
    { path: '/api/ai-calls/sessions/[id]/finalize', methods: ['POST'], reason: 'AI-call audio bridge; the route requires X-Bridge-Token = BRIDGE_SHARED_TOKEN (strong secret, constant-time, refuses when unset)' },
    { path: '/api/ai-calls/sessions/by-fs-uuid/[fsUuid]', methods: ['GET'], reason: 'AI-call audio bridge; the route requires X-Bridge-Token = BRIDGE_SHARED_TOKEN (strong secret, constant-time, refuses when unset)' },
    { path: '/api/internal/ai-call-keys', methods: ['GET'], reason: 'AI-call audio bridge runtime keys; the route requires X-Bridge-Token = BRIDGE_SHARED_TOKEN (strong secret, constant-time, refuses when unset)' },
]

const ALLOWLIST_PARAMETER_SEGMENT = /^\[[A-Za-z]+\]$/
const ALLOWLIST_PARAMETER_VALUE = /^[A-Za-z0-9_-]{1,128}$/

/** Whether `pathname` is exactly `template`, a `[name]` segment matching one plain segment. */
function matchesAllowlistedPath(template: string, pathname: string): boolean {
    const expected = template.split('/')
    const actual = pathname.split('/')
    if (expected.length !== actual.length) return false
    return expected.every((segment, index) => (
        ALLOWLIST_PARAMETER_SEGMENT.test(segment)
            ? ALLOWLIST_PARAMETER_VALUE.test(actual[index])
            : segment === actual[index]
    ))
}

/**
 * The server actions a request without a verified session may run, per page:
 * the lane it is for, the build worker of that page and the `file#export` of
 * each action. Only sign-in. The id an action is posted with is looked up in the build's own
 * server-reference manifest, so an id that is not one of these, or is these
 * but posted to another page, is refused.
 */
export const SESSIONLESS_SERVER_ACTIONS: Readonly<Record<string, { readonly lane: 'browser' | 'shell', readonly worker: string, readonly actions: readonly string[] }>> = {
    '/login': {
        lane: 'browser',
        worker: 'app/login/page',
        actions: [
            'src/lib/users/user-service.ts#getLoginMode',
            'src/lib/users/user-service.ts#getUsers',
            'src/lib/users/user-service.ts#staffLogin',
        ],
    },
    '/login/mobile': {
        lane: 'shell',
        worker: 'app/login/mobile/page',
        actions: ['src/app/login/mobile/actions.ts#submitMobileLoginAction'],
    },
}

type ActionManifestNodeV1 = Record<string, { workers?: Record<string, { filename?: unknown, exportedName?: unknown }> }>

let actionManifestCache: { path: string, mtimeMs: number, node: ActionManifestNodeV1 } | null = null

/** The build's server-action manifest (`next start`: .next/server; `next dev`: .next/dev/server), or null. */
function readActionManifest(): ActionManifestNodeV1 | null {
    const distDir = process.env.NODE_ENV === 'production' ? '.next' : join('.next', 'dev')
    const path = join(process.cwd(), distDir, 'server', 'server-reference-manifest.json')
    try {
        const { mtimeMs } = statSync(path)
        if (actionManifestCache?.path === path && actionManifestCache.mtimeMs === mtimeMs) return actionManifestCache.node
        const node = (JSON.parse(readFileSync(path, 'utf8')) as { node?: unknown })?.node
        if (node === null || typeof node !== 'object') throw new Error('manifest without node actions')
        actionManifestCache = { path, mtimeMs, node: node as ActionManifestNodeV1 }
        return actionManifestCache.node
    } catch (error) {
        console.error('[proxy] server-action manifest unreadable; session-less actions refused:', error instanceof Error ? error.name : 'unknown')
        return null
    }
}

/** Whether `actionId`, posted to `pathname` in `lane`, is one of that page's pinned session-less actions. */
function isSessionlessServerAction(lane: 'browser' | 'shell', pathname: string, actionId: string): boolean {
    if (!Object.hasOwn(SESSIONLESS_SERVER_ACTIONS, pathname) || !/^[0-9a-f]{2,64}$/.test(actionId)) return false
    const pin = SESSIONLESS_SERVER_ACTIONS[pathname]
    if (pin.lane !== lane) return false
    const manifest = readActionManifest()
    if (manifest === null || !Object.hasOwn(manifest, actionId)) return false
    const workers = manifest[actionId]?.workers
    if (!workers || typeof workers !== 'object' || !Object.hasOwn(workers, pin.worker)) return false
    const { filename, exportedName } = workers[pin.worker] ?? {}
    return typeof filename === 'string' && typeof exportedName === 'string'
        && pin.actions.includes(`${filename}#${exportedName}`)
}

function isApiPath(pathname: string): boolean {
    return pathname === '/api' || pathname.startsWith('/api/')
}

/** A same-origin path to come back to after sign-in, never another origin. */
function loginReturnTarget(request: NextRequest): string {
    const target = `${request.nextUrl.pathname}${request.nextUrl.search}`
    return target.startsWith('/') && !target.startsWith('//') && !target.includes('\\') ? target : '/'
}

const NO_STORE = { 'cache-control': 'no-store' }

/**
 * A browser request without a verified session while enforcement is on:
 * allowlisted → on with no identity; otherwise refused.
 */
function answerSessionlessEnforced(request: NextRequest, pathname: string): NextResponse {
    const method = request.method.toUpperCase()
    const actionId = request.headers.get('next-action')
    if (actionId !== null) {
        return isSessionlessServerAction('browser', pathname, actionId)
            ? forwardWithOperator(request, null)
            : NextResponse.json({ error: 'staff_session_required' }, { status: 401, headers: NO_STORE })
    }
    if (ENFORCED_SESSIONLESS_ALLOWLIST.some((entry) => entry.methods.includes(method) && matchesAllowlistedPath(entry.path, pathname))) {
        return forwardWithOperator(request, null)
    }
    if ((method === 'GET' || method === 'HEAD') && !isApiPath(pathname)) {
        const login = new URL('/login', request.url)
        login.searchParams.set('next', loginReturnTarget(request))
        return NextResponse.redirect(login, { status: 303, headers: NO_STORE })
    }
    return NextResponse.json({ error: 'staff_session_required' }, { status: 401, headers: NO_STORE })
}

/**
 * The shell lane's public paths while enforcement is on. A forged marker must
 * not open more than the enforced browser lane, so a session-less write there
 * is only the pinned mobile sign-in action or the exact native logout.
 */
function isShellSessionlessRequestAllowedEnforced(request: NextRequest, pathname: string): boolean {
    const actionId = request.headers.get('next-action')
    if (actionId !== null) return isSessionlessServerAction('shell', pathname, actionId)
    const method = request.method.toUpperCase()
    return method === 'GET' || method === 'HEAD' || SHELL_PUBLIC_PATHS.has(pathname)
}

const SERVICE_UNAVAILABLE_PAGE ='<!doctype html><html lang="ru"><head><meta charset="utf-8">'
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
    const staffCookie = shell ? undefined : request.cookies.get(staffSessionCookieNameForRequestV1())?.value
    const enforced = isStaffSessionEnforcedForRequestV1()
    const enforce = !shell && enforced

    // The browser lane without any session and without enforcement is
    // deliberately unchanged.
    if (!shell && sessionCookie === undefined && staffCookie === undefined && !enforce) return NextResponse.next()

    const operator = await resolveCookieOperatorV1(
        sessionCookie,
        request.cookies.get(LEGACY_UI_IDENTITY_COOKIE_V1)?.value,
        staffCookie,
    )
    if (operator.kind === 'mobile_session') return forwardWithOperator(request, operator.operatorId)

    if (!shell) {
        if (operator.kind === 'staff_session') return forwardWithOperator(request, operator.operatorId)
        if (operator.kind === 'staff_session_refused' && operator.unverifiable) {
            const headers = { 'retry-after': '5', 'cache-control': 'no-store' }
            if (pathname.startsWith('/api/')) {
                return NextResponse.json({ error: 'staff_session_unverifiable' }, { status: 503, headers })
            }
            return new NextResponse(SERVICE_UNAVAILABLE_PAGE, {
                status: 503,
                headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
            })
        }
        // No verified session under enforcement: the allowlist or a refusal.
        if (enforce) return answerSessionlessEnforced(request, pathname)
        // A refused or conflicting session without enforcement: no identity
        // downstream, never one the client chose.
        return forwardWithOperator(request, null)
    }

    // From here the request has no signed operator: no session at all in the
    // shell lane, or a session cookie that grants nothing in either lane. It
    // never reaches anything with an identity it could choose itself.
    if (!shell || SHELL_PUBLIC_PATHS.has(pathname) || SHELL_PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
        if (enforced && !isShellSessionlessRequestAllowedEnforced(request, pathname)) {
            return NextResponse.json({ error: 'mobile_session_required' }, { status: 401, headers: NO_STORE })
        }
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

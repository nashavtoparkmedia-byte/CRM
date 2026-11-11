#!/usr/bin/env node

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const appRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(appRoot, '..')
const requireBuild = process.argv.includes('--require-build')

const removedRoute = join(appRoot, 'src/app/api/debug-db/list-connections/route.ts')
assert.equal(existsSync(removedRoute), false, 'credential-leaking list-connections route must be absent')

const removedCleanupRoute = join(appRoot, 'src/app/api/debug-db/cleanup-chats/route.ts')
assert.equal(existsSync(removedCleanupRoute), false, 'foreign-writing cleanup-chats route must be absent')

// The proxy matcher widened when the Android shell lane was closed at the
// request boundary, so pinning the old literal matcher would now fail on a
// change that strengthened the file. What has to hold is the guarantee, not
// the spelling: the debug-db denial still runs inside the app, it still
// answers 404, and the matcher still reaches /api/. Behavioural proof that the
// denial actually fires for both lanes lives in
// src/lib/security/mobile-shell-lane.test.ts, which imports the proxy and
// calls it — strictly stronger than the regex this replaces.
const proxySource = readFileSync(join(appRoot, 'src/proxy.ts'), 'utf8')
assert.match(
    proxySource,
    /pathname\.startsWith\(\s*['"]\/api\/debug-db['"]\s*\)/,
    'the application-level debug-db denial must remain in the proxy',
)
assert.match(proxySource, /status:\s*404/)
const proxyMatchers = proxySource.match(/matcher:\s*\[([\s\S]*?)\]/)?.[1] ?? ''
assert.notEqual(proxyMatchers.trim(), '', 'the proxy must declare a matcher')
assert.equal(
    /api/.test(proxyMatchers) && !/\/api\/debug-db/.test(proxyMatchers),
    false,
    'the proxy matcher must still reach /api/debug-db',
)

// Enforcement without a verified session (docs/design/staff-session-enforce-deny-v1.md):
// the proxy reaches every path but the build output, the session-less allowlist
// is exactly the reviewed one, and each listed route keeps its own gate, because
// being listed is never the gate. Behaviour: src/lib/security/staff-session-enforce-deny.test.ts.
assert.equal(
    proxyMatchers.trim(),
    "'/((?!_next/static|_next/image|favicon.ico).*)'",
    'the proxy matcher must stay the catch-all minus the build output',
)
const reviewedSessionlessAllowlist = [
    { path: '/login', methods: ['GET', 'HEAD'], file: 'src/app/login/page.tsx', gate: null },
    { path: '/api/mobile/push-registration', methods: ['POST'], gate: 'registerMobilePushDeviceFromSessionV1(' },
    { path: '/api/mobile/session/logout', methods: ['POST'], gate: 'endMobileSessionForRequestV1(' },
    { path: '/api/webhooks/bot', methods: ['POST'], gate: 'process.env.BOT_CRM_SECRET' },
    { path: '/api/webhook/telegram', methods: ['POST'], gate: 'telegramIngressAuthorized(req)' },
    { path: '/api/webhooks/max', methods: ['POST'], gate: 'isAuthorizedMaxScraperWebhookV1(request)' },
    { path: '/api/webhook/max/reaction', methods: ['POST'], gate: 'isAuthorizedMaxScraperWebhookV1(req)' },
    { path: '/api/ai-calls/sessions/[id]/state', methods: ['POST'], gate: 'isBridgeMachineRequestAuthenticated(req.headers)' },
    { path: '/api/ai-calls/sessions/[id]/transcript-item', methods: ['POST'], gate: 'isBridgeMachineRequestAuthenticated(req.headers)' },
    { path: '/api/ai-calls/sessions/[id]/finalize', methods: ['POST'], gate: 'isBridgeMachineRequestAuthenticated(req.headers)' },
    { path: '/api/ai-calls/sessions/by-fs-uuid/[fsUuid]', methods: ['GET'], gate: 'isBridgeMachineRequestAuthenticated(req.headers)' },
    { path: '/api/internal/ai-call-keys', methods: ['GET'], gate: 'isBridgeMachineRequestAuthenticated(req.headers)' },
]
const allowlistSource = proxySource.match(/export const ENFORCED_SESSIONLESS_ALLOWLIST[^=]*=\s*\[([\s\S]*?)\n\]/)?.[1] ?? ''
const declaredSessionlessAllowlist = [...allowlistSource.matchAll(/\{\s*path:\s*'([^']+)',\s*methods:\s*\[([^\]]*)\],\s*reason:\s*'[^']{20,}'\s*\}/g)]
    .map(([, path, methods]) => ({ path, methods: [...methods.matchAll(/'([A-Z]+)'/g)].map(([, method]) => method) }))
assert.equal(
    (allowlistSource.match(/\{\s*path:/g) ?? []).length,
    declaredSessionlessAllowlist.length,
    'every session-less allowlist entry must be a literal { path, methods, reason } with a reason',
)
assert.deepEqual(
    declaredSessionlessAllowlist,
    reviewedSessionlessAllowlist.map(({ path, methods }) => ({ path, methods })),
    'the session-less allowlist must be exactly the reviewed exact paths and methods',
)
assert.match(
    proxySource,
    /entry\.methods\.includes\(method\)\s*&&\s*matchesAllowlistedPath\(entry\.path,\s*pathname\)/,
    'the allowlist must be matched by exact path template and method, never by prefix',
)
for (const { path, file, gate } of reviewedSessionlessAllowlist) {
    const routeFile = file ?? `src/app${path}/route.ts`
    assert.ok(existsSync(join(appRoot, routeFile)), `${path}: the listed surface ${routeFile} must exist`)
    if (gate !== null) {
        assert.ok(
            readFileSync(join(appRoot, routeFile), 'utf8').includes(gate),
            `${path}: a listed route must keep its own gate (${gate})`,
        )
    }
}
const sessionlessActionsSource = proxySource.match(/export const SESSIONLESS_SERVER_ACTIONS[^=]*=\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
assert.deepEqual(
    [...sessionlessActionsSource.matchAll(/'([^']+)'/g)].map(([, literal]) => literal),
    [
        '/login', 'browser', 'app/login/page',
        'src/lib/users/user-service.ts#getLoginMode',
        'src/lib/users/user-service.ts#getSignInEmployees',
        'src/lib/users/user-service.ts#staffLogin',
        '/login/mobile', 'shell', 'app/login/mobile/page',
        'src/app/login/mobile/actions.ts#submitMobileLoginAction',
    ],
    'the session-less server actions must be exactly the reviewed sign-in actions',
)
// The session-less sign-in list carries no contact data: /login reads the minimal list, never the full registry.
const loginPageSource = readFileSync(join(appRoot, 'src/app/login/page.tsx'), 'utf8')
assert.match(loginPageSource, /getSignInEmployees\(\)/, '/login must list employees through getSignInEmployees')
assert.doesNotMatch(loginPageSource, /\bgetUsers\b/, '/login must not call the full registry read session-less')
const signInListSource = readFileSync(join(appRoot, 'src/lib/users/user-service.ts'), 'utf8')
    .match(/export async function getSignInEmployees\(\)[\s\S]*?\n\}/)?.[0] ?? ''
assert.match(signInListSource, /record\.status === 'Активен'/, 'the sign-in list must hold active employees only')
assert.match(signInListSource, /\(\{ id, firstName, lastName, role \}\) => \(\{ id, firstName, lastName, role \}\)/, 'the sign-in list must carry id, name and role only')
// The shell sign-in page renders without a session too: its picker gets the same minimal projection.
assert.match(
    readFileSync(join(appRoot, 'src/app/login/mobile/page.tsx'), 'utf8'),
    /\.filter\(\(user\) => user\.status === 'Активен'\)\s*\.map\(\(\{ id, firstName, lastName, role \}\) => \(\{ id, firstName, lastName, role \}\)\)/,
    '/login/mobile must pass only active employees, id, name and role, to its picker',
)
const sessionlessPins = [
    ['app/login/page', 'src/lib/users/user-service.ts', 'getLoginMode'],
    ['app/login/page', 'src/lib/users/user-service.ts', 'getSignInEmployees'],
    ['app/login/page', 'src/lib/users/user-service.ts', 'staffLogin'],
    ['app/login/mobile/page', 'src/app/login/mobile/actions.ts', 'submitMobileLoginAction'],
]

const nginxSource = readFileSync(join(repositoryRoot, 'deploy/nginx/templates/crm.conf.template'), 'utf8')
const nginxDenials = nginxSource.match(/location\s+\^~\s+\/api\/debug-db\s*\{[\s\S]*?return\s+404\s*;/g) ?? []
assert.equal(nginxDenials.length, 2, 'both public CRM TLS virtual hosts must deny /api/debug-db')

const dockerfileSource = readFileSync(join(appRoot, 'Dockerfile'), 'utf8')
const pinnedNodeBase = 'node:20-bookworm-slim@sha256:3d0f05455dea2c82e2f76e7e2543964c30f6b7d673fc1a83286736d44fe4c41c'
assert.equal(
    dockerfileSource.split(`FROM ${pinnedNodeBase} AS `).length - 1,
    3,
    'all Gravity image stages must use the exact reviewed Node base digest',
)
const authenticatedSnapshotSources = dockerfileSource.match(
    /^\s*'deb \[check-valid-until=no\] http:\/\/snapshot\.debian\.org\/archive\/(?:debian|debian-security)\/20260801T000000Z bookworm(?:-updates|-security)? main' \\/gm,
) ?? []
assert.equal(
    authenticatedSnapshotSources.length,
    9,
    'all Gravity APT sources must use the exact immutable Debian snapshot',
)
assert.doesNotMatch(
    dockerfileSource,
    /(?:trusted\s*=\s*yes|allow-unauthenticated|allowinsecurerepositories|verify-peer\s*=\s*false)/i,
    'Gravity APT bootstrap must retain Debian signature and package-hash verification',
)

const cookieImporter = readFileSync(
    join(repositoryRoot, 'yandex-fleet-scraper/src/scripts/import-chrome-cookies.ts'),
    'utf8',
)
assert.doesNotMatch(
    cookieImporter,
    /(?:console\.|sample[\s\S]{0,240})[^\n]*(?:\.value\b|value\s*[:=]).*(?:slice|substring|substr|console)/i,
    'Chrome cookie diagnostics must not emit decrypted value bytes or prefixes',
)
assert.match(
    cookieImporter,
    /imported cookie metadata \(values redacted\)/,
    'Chrome cookie diagnostics must explicitly identify their redacted metadata output',
)

function walk(directory) {
    if (!existsSync(directory)) return []
    return readdirSync(directory).flatMap(name => {
        const path = join(directory, name)
        return statSync(path).isDirectory() ? walk(path) : [path]
    })
}

const builtAppRoot = join(appRoot, '.next/server/app')
const builtRoutes = walk(builtAppRoot)
    .map(path => relative(builtAppRoot, path).replaceAll('\\', '/'))
if (requireBuild) {
    const leakedBuiltRoute = builtRoutes.find(path => path.startsWith('api/debug-db/list-connections/'))
    assert.equal(leakedBuiltRoute, undefined, 'removed debug connection route must not exist in built app output')
    const leakedCleanupRoute = builtRoutes.find(path => path.startsWith('api/debug-db/cleanup-chats/'))
    assert.equal(leakedCleanupRoute, undefined, 'removed debug cleanup route must not exist in built app output')
}

const routingManifestPaths = [
    join(appRoot, '.next/server/middleware-manifest.json'),
    join(appRoot, '.next/server/functions-config-manifest.json'),
].filter(existsSync)
if (requireBuild) {
    assert.ok(routingManifestPaths.length > 0, 'Next middleware/proxy manifest is required after build')
    // Availability: every session-less pin resolves in the build's own action manifest, on its page's worker.
    const actionManifest = JSON.parse(readFileSync(join(appRoot, '.next/server/server-reference-manifest.json'), 'utf8')).node
    for (const [worker, filename, exportedName] of sessionlessPins) {
        const resolved = Object.values(actionManifest).filter((entry) => {
            const onWorker = entry?.workers?.[worker]
            return onWorker?.filename === filename && onWorker?.exportedName === exportedName
        })
        assert.equal(resolved.length, 1, `${filename}#${exportedName} must resolve once on ${worker} in the built action manifest`)
    }
}

if (routingManifestPaths.length > 0) {
    const regexps = []
    const visit = value => {
        if (Array.isArray(value)) return value.forEach(visit)
        if (value === null || typeof value !== 'object') return
        for (const [key, entry] of Object.entries(value)) {
            if (key === 'regexp' && typeof entry === 'string') regexps.push(entry)
            else visit(entry)
        }
    }
    for (const manifestPath of routingManifestPaths) {
        visit(JSON.parse(readFileSync(manifestPath, 'utf8')))
    }
    const isBlockedByBuiltProxy = regexps.some(regexp => {
        try {
            const matcher = new RegExp(regexp)
            return matcher.test('/api/debug-db') && matcher.test('/api/debug-db/list-connections')
        } catch {
            return false
        }
    })
    assert.ok(isBlockedByBuiltProxy, 'built proxy manifest must cover the complete /api/debug-db prefix')
}

console.log(`public-boundary-check: PASS (${requireBuild ? 'source+build' : 'source'})`)

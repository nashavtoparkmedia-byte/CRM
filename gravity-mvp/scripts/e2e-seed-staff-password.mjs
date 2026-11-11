#!/usr/bin/env node
/**
 * E2E only: give one test employee a personal Staff Session password in a
 * DISPOSABLE CRM, through the product's own bootstrap over HTTP
 * (docs/design/mobile-personal-signin-v1.md §3 item 4).
 *
 *   node scripts/e2e-seed-staff-password.mjs --base http://127.0.0.1:3013 --user u1
 *
 * Environment (test values only; never printed):
 *   ADMIN_USER / ADMIN_PASS          the integration-admin sign-in of that CRM
 *   E2E_STAFF_PASSWORD               the password the test employee gets
 *   E2E_ADMIN_STAFF_PASSWORD         the bootstrapped Администратор's password
 *                                    (only needed when --user is not an Администратор)
 *
 * It writes nothing to a database itself. It works only where the bootstrap
 * window is open (no StaffCredential row yet, enforcement off), which is
 * exactly a fresh disposable CRM.
 *
 * C1 (Security): a production CRM before its first bootstrap has that window
 * open too, and the CI password is public. So this refuses every base URL that
 * is not loopback BEFORE it sends anything. It must never be referenced from
 * deploy/ or the operations docs (scripts/check-public-boundaries.mjs pins
 * that). Production: the Owner bootstraps the first Администратор with a fresh
 * password before anything else touches the instance.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** The base URL as a URL, or an Error when it is not plain http(s) on a loopback host. */
export function loopbackBaseUrlV1(value) {
    let url
    try {
        url = new URL(value)
    } catch {
        return new Error('base URL is not a URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return new Error('base URL must be http(s)')
    if (url.username || url.password) return new Error('base URL must not carry credentials')
    if (!LOOPBACK_HOSTS.has(url.hostname)) return new Error('refused: the seed runs only against a loopback CRM (127.0.0.1, ::1, localhost)')
    if (url.pathname !== '/' || url.search || url.hash) return new Error('base URL must be an origin')
    return url
}

function actionId(manifest, worker, filename, exportedName) {
    for (const [id, entry] of Object.entries(manifest)) {
        const onWorker = entry?.workers?.[worker]
        if (onWorker?.filename === filename && onWorker?.exportedName === exportedName) return id
    }
    throw new Error(`${filename}#${exportedName} is not in the build manifest for ${worker}`)
}

function cookieFrom(response, name) {
    for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';')
        const index = pair.indexOf('=')
        if (pair.slice(0, index) === name && pair.slice(index + 1) !== '') return `${name}=${pair.slice(index + 1)}`
    }
    return null
}

async function callAction(base, page, id, args, cookie) {
    const response = await fetch(new URL(page, base), {
        method: 'POST',
        redirect: 'manual',
        headers: { 'next-action': id, 'content-type': 'text/plain;charset=UTF-8', accept: 'text/x-component', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(args),
    })
    return { response, text: await response.text() }
}

export async function seedStaffPasswordV1({ base, userId, appRoot, env = process.env }) {
    const origin = loopbackBaseUrlV1(base)
    if (origin instanceof Error) throw origin
    for (const name of ['ADMIN_USER', 'ADMIN_PASS', 'E2E_STAFF_PASSWORD']) {
        if (!env[name]) throw new Error(`${name} is required`)
    }
    const manifest = JSON.parse(readFileSync(join(appRoot, '.next/server/server-reference-manifest.json'), 'utf8')).node
    const registry = JSON.parse(readFileSync(env.YOKO_USER_REGISTRY_FILE ?? join(appRoot, 'src/data/users.json'), 'utf8'))
    const target = registry.find((record) => record.id === userId)
    if (!target) throw new Error('the employee is not in the registry')

    // 1. The integration-admin sign-in, as the page's own no-JS form posts it.
    const signIn = actionId(manifest, 'app/settings/integrations/access/page', 'src/app/settings/integrations/access/actions.ts', 'signInIntegrationAdmin')
    const form = new FormData()
    form.set(`$ACTION_ID_${signIn}`, '')
    form.set('username', env.ADMIN_USER)
    form.set('password', env.ADMIN_PASS)
    form.set('next', '/users')
    const signedIn = await fetch(new URL('/settings/integrations/access', origin), { method: 'POST', redirect: 'manual', body: form })
    const adminCookie = cookieFrom(signedIn, 'yoko_integration_admin_session')
    if (!adminCookie) throw new Error(`integration-admin sign-in refused (${signedIn.status})`)

    const setPassword = actionId(manifest, 'app/users/page', 'src/lib/users/user-service.ts', 'setStaffPassword')
    const ok = (text) => /"ok":true/.test(text)

    // 2. The bootstrap may set an Администратор's password only.
    if (target.role === 'Администратор') {
        const set = await callAction(origin, '/users', setPassword, [target.id, env.E2E_STAFF_PASSWORD], adminCookie)
        if (!ok(set.text)) throw new Error('the bootstrap password was refused')
        return { userId: target.id, via: 'bootstrap' }
    }

    // 3. Otherwise: bootstrap an Администратор, sign in as them, and let them set the employee's password.
    if (!env.E2E_ADMIN_STAFF_PASSWORD) throw new Error('E2E_ADMIN_STAFF_PASSWORD is required for a non-Администратор employee')
    const admin = registry.find((record) => record.role === 'Администратор' && record.status === 'Активен')
    if (!admin) throw new Error('the registry has no active Администратор')
    const boot = await callAction(origin, '/users', setPassword, [admin.id, env.E2E_ADMIN_STAFF_PASSWORD], adminCookie)
    if (!ok(boot.text)) throw new Error('the bootstrap password was refused')
    const staffLogin = actionId(manifest, 'app/login/page', 'src/lib/users/user-service.ts', 'staffLogin')
    const login = await callAction(origin, '/login', staffLogin, [admin.id, env.E2E_ADMIN_STAFF_PASSWORD])
    const staffCookie = cookieFrom(login.response, '__Host-yoko_staff_session') ?? cookieFrom(login.response, 'yoko_staff_session')
    if (!staffCookie || !ok(login.text)) throw new Error('the Администратор sign-in was refused')
    const set = await callAction(origin, '/users', setPassword, [target.id, env.E2E_STAFF_PASSWORD], staffCookie)
    if (!ok(set.text)) throw new Error('the employee password was refused')
    return { userId: target.id, via: admin.id }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const arg = (name) => {
        const index = process.argv.indexOf(name)
        return index === -1 ? undefined : process.argv[index + 1]
    }
    const base = arg('--base')
    const userId = arg('--user')
    const refused = loopbackBaseUrlV1(base ?? '')
    if (refused instanceof Error || !userId) {
        console.error(refused instanceof Error ? refused.message : '--user is required')
        process.exit(2)
    }
    seedStaffPasswordV1({ base, userId, appRoot: join(fileURLToPath(new URL('.', import.meta.url)), '..') })
        .then((result) => { console.log(`seeded a personal password for ${result.userId} (via ${result.via})`) })
        .catch((error) => { console.error(`seed failed: ${error.message}`); process.exit(1) })
}

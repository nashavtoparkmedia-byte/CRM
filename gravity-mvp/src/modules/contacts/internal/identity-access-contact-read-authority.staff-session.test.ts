/**
 * ContactReadAuthorityQuery.v1 against the REAL Identity Access Staff Session
 * path (Security D2 evidence 1 and 2): real tokens, a real registry file and the
 * real request boundary, with only the credential store held in memory.
 *
 * - A staff cookie on a lane with no secret is refused; the integration-admin
 *   session beside it is not consulted.
 * - With both sessions, a real Менеджер token stays the Менеджер: the principal
 *   is the employee, never the integration-admin session.
 * - Every reader role sees the full ВУ (Owner 2026-11-11); a role changed in the
 *   registry applies on the next request, and a disabled employee is refused.
 * - An unreadable store: inside a route the answer is a denial; at the request
 *   boundary every D2 path (pages, the lookup and ВУ-search APIs, the referral
 *   page and its server-action POST) is answered 503 before any of them runs, and the
 *   boundary's matcher covers each of them.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// ── An in-memory StaffCredential store with the real store's surface ─────
const fake = vi.hoisted(() => {
  interface Row {
    userId: string
    registryCreatedAt: string
    verifier: { algo: 'scrypt'; n: number; r: number; p: number; maxmemBytes: number; salt: Buffer; hash: Buffer }
    sessionEpoch: number
    revokedAt: Date | null
  }
  const state = { rows: new Map<string, Row>(), unreadable: false, chain: Promise.resolve() as Promise<unknown> }
  const check = () => { if (state.unreadable) throw Object.assign(new Error('store down'), { name: 'PrismaClientInitializationError' }) }
  const clone = (row: Row | undefined) => (row === undefined ? null : { ...row })
  const view = {
    async find(userId: string) { check(); return clone(state.rows.get(userId)) },
    async liveUserIds() { check(); return new Set([...state.rows.values()].filter((row) => row.revokedAt === null).map((row) => row.userId)) },
    async upsertVerifier(input: { userId: string; registryCreatedAt: string; verifier: Row['verifier'] }) {
      check()
      const existing = state.rows.get(input.userId)
      const row: Row = { ...input, sessionEpoch: existing === undefined ? 0 : existing.sessionEpoch + 1, revokedAt: null }
      state.rows.set(input.userId, row)
      return { ...row }
    },
    async bumpEpoch(userId: string) { check(); const row = state.rows.get(userId); if (!row) return null; row.sessionEpoch += 1; return { ...row } },
    async revoke(userId: string, _actor: string, now: Date) {
      check(); const row = state.rows.get(userId); if (!row) return null; row.revokedAt ??= now; row.sessionEpoch += 1; return { ...row }
    },
    async record() { check() },
  }
  const store = {
    findStatus: view.find,
    async findVerifier(userId: string) { check(); const row = state.rows.get(userId); return row === undefined ? null : { status: { ...row }, verifier: row.verifier } },
    async anyRow() { check(); return state.rows.size > 0 },
    async states() { check(); return [...state.rows.values()].map((row) => ({ userId: row.userId, revoked: row.revokedAt !== null })) },
    record: view.record,
    async locked<T>(work: (v: typeof view) => Promise<T>): Promise<T> {
      check()
      const run = state.chain.then(() => work(view))
      state.chain = run.catch(() => undefined)
      return run
    },
  }
  return { state, store }
})
vi.mock('@/modules/identity-access/internal/staff-credential-store', () => ({ prismaStaffCredentialStoreV1: fake.store }))
vi.mock('@/modules/identity-access/internal/mobile-session-barrier', () => ({ prismaMobileSessionBarrierV1: { isBarred: async () => false } }))

// ── The request as next/headers hands it to a route ───────────────────────
const request = vi.hoisted(() => ({ cookies: new Map<string, string>() }))
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers({ 'user-agent': 'Mozilla/5.0 Chrome/120' }),
}))

const credentials = await import('@/modules/identity-access/internal/staff-session-credentials')
const operations = await import('@/modules/identity-access/application/staff-session-operations')
const { issueIntegrationAdminSession, INTEGRATION_ADMIN_SESSION_COOKIE } = await import('@/modules/identity-access/public/v1/integration-admin-credentials')
const { resolveContactReadAuthorityFromIdentityAccessV1: resolve } = await import('./identity-access-contact-read-authority')
const { resolveContactWriteAuthorityFromIdentityAccessV1: resolveWriter } = await import('./identity-access-contact-write-authority')
const { MOBILE_SESSION_COOKIE } = await import('@/modules/identity-access/public/v1/mobile-session-credentials')
const { NextRequest } = await import('next/server')
const { proxy, config } = await import('@/proxy')

const STAFF_COOKIE = '__Host-yoko_staff_session'
const SECRET = 'staff-session-signing-key-for-tests-0123456789abcdef'
const ADMIN = { id: 'u2', firstName: 'Александр', lastName: 'Сидоров', role: 'Администратор', status: 'Активен', createdAt: '2026-03-24T00:00:00Z' }
const MANAGER = { id: 'u1', firstName: 'Мария', lastName: 'Иванова', role: 'Менеджер', status: 'Активен', createdAt: '2026-03-24T00:00:00Z' }
const PASSWORD = 'staff pass phrase 2026'

let directory: string
let registryFile: string

function writeRegistry(records: unknown[]): void {
  writeFileSync(registryFile, JSON.stringify(records, null, 2))
}

function configureLane(): void {
  vi.stubEnv('STAFF_SESSION_SECRET', SECRET)
  vi.stubEnv('YOKO_USER_REGISTRY_FILE', registryFile)
}

function configureAdmin(): void {
  vi.stubEnv('ADMIN_USER', 'project-operator')
  vi.stubEnv('ADMIN_PASS', 'correct horse battery staple')
}

async function staffToken(userId: string): Promise<string> {
  const verifier = await credentials.createStaffPasswordVerifierV1(PASSWORD)
  fake.state.rows.set(userId, { userId, registryCreatedAt: '2026-03-24T00:00:00Z', verifier, sessionEpoch: 0, revokedAt: null })
  const result = await operations.staffLoginV1({ userId, password: PASSWORD, source: null })
  if (!result.ok) throw new Error(`login refused: ${result.reason}`)
  return result.token
}

function asRequest(cookies: Record<string, string>): void {
  request.cookies.clear()
  for (const [name, value] of Object.entries(cookies)) request.cookies.set(name, value)
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'contact-read-authority-'))
  registryFile = path.join(directory, 'users.json')
  writeRegistry([MANAGER, ADMIN])
  fake.state.rows.clear()
  fake.state.unreadable = false
  request.cookies.clear()
  operations.resetStaffLoginThrottleForTestsV1()
  for (const name of ['STAFF_SESSION_SECRET', 'YOKO_USER_REGISTRY_FILE', 'YOKO_USER_REGISTRY_SEED', 'YOKO_STAFF_SESSION_ENFORCE', 'STAFF_SESSION_REVOCATION_EPOCH', 'ADMIN_USER', 'ADMIN_PASS', 'MOBILE_ACCESS_USER', 'MOBILE_ACCESS_PASS', 'BOT_CRM_SECRET']) {
    vi.stubEnv(name, undefined as unknown as string)
  }
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe('ContactReadAuthorityQuery.v1 over the real Staff Session path', () => {
  test('a staff cookie on a lane without a secret is refused, and the admin session beside it is not used', async () => {
    configureAdmin()
    const admin = issueIntegrationAdminSession()!
    asRequest({ [STAFF_COOKIE]: 'any.token', [INTEGRATION_ADMIN_SESSION_COOKIE]: admin })
    await expect(resolve()).resolves.toEqual({ decision: 'deny', reason: 'staff_session_refused' })
    // The same admin session alone is the transitional reader.
    asRequest({ [INTEGRATION_ADMIN_SESSION_COOKIE]: admin })
    await expect(resolve()).resolves.toMatchObject({ decision: 'allow', principal: { kind: 'integration_admin_session' }, licenceView: 'full' })
  })

  test('both sessions: a real Менеджер token stays the Менеджер, never the admin session', async () => {
    configureLane()
    configureAdmin()
    const token = await staffToken('u1')
    asRequest({ [STAFF_COOKIE]: token, [INTEGRATION_ADMIN_SESSION_COOKIE]: issueIntegrationAdminSession()!, crm_user_id: 'u2' })
    await expect(resolve()).resolves.toEqual({
      decision: 'allow',
      principal: { kind: 'staff_session', userId: 'u1', role: 'Менеджер' },
      licenceView: 'full',
      policyVersion: 'contacts.read-authority.v1',
    })
  })

  test('only crm_user_id: no reader at all', async () => {
    configureLane()
    asRequest({ crm_user_id: 'u2' })
    await expect(resolve()).resolves.toEqual({ decision: 'deny', reason: 'no_session' })
  })

  test('a role changed in the registry applies on the next request, and a disabled employee is refused', async () => {
    configureLane()
    const token = await staffToken('u2')
    asRequest({ [STAFF_COOKIE]: token })
    await expect(resolve()).resolves.toMatchObject({ decision: 'allow', principal: { role: 'Администратор' }, licenceView: 'full' })
    writeRegistry([MANAGER, { ...ADMIN, role: 'Менеджер' }])
    await expect(resolve()).resolves.toMatchObject({ decision: 'allow', principal: { role: 'Менеджер' }, licenceView: 'full' })
    writeRegistry([MANAGER, { ...ADMIN, role: 'Оператор' }])
    await expect(resolve()).resolves.toEqual({ decision: 'deny', reason: 'staff_session_refused' })
    writeRegistry([MANAGER, { ...ADMIN, status: 'Отключен' }])
    await expect(resolve()).resolves.toEqual({ decision: 'deny', reason: 'staff_session_refused' })
  })

  test('an unreadable store: a route sees a denial, and the boundary answers 503 on every D2 path first', async () => {
    configureLane()
    const token = await staffToken('u1')
    fake.state.unreadable = true
    asRequest({ [STAFF_COOKIE]: token })
    await expect(resolve()).resolves.toEqual({ decision: 'deny', reason: 'staff_session_refused' })
    const matcher = new RegExp(`^${config.matcher[0]}$`, 'u')
    const paths: Array<[string, string]> = [
      ['/contacts', 'GET'],
      ['/contacts/ci-demo-contact-gromov', 'GET'],
      ['/api/contacts/lookup?q=%D0%98%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2', 'GET'],
      ['/contacts/licence-search', 'POST'],
      ['/compensation/referrals', 'GET'],
      ['/compensation/referrals', 'POST'],
    ]
    for (const [target, method] of paths) {
      const url = new URL(`https://yokoone.ru${target}`)
      expect(matcher.test(url.pathname), `matcher covers ${url.pathname}`).toBe(true)
      const headers = new Headers({ 'user-agent': 'Mozilla/5.0 Chrome/120', cookie: `${STAFF_COOKIE}=${token}` })
      const response = await proxy(new NextRequest(url, { headers, method }))
      expect(response.status, `${method} ${target}`).toBe(503)
    }
  })

  test('the write authority: a real employee writes as staff:<id>; mobile, crm_user_id or a refused cookie never write (W2, W3)', async () => {
    configureLane()
    configureAdmin()
    const token = await staffToken('u1')
    const admin = issueIntegrationAdminSession()!
    asRequest({ [STAFF_COOKIE]: token })
    await expect(resolveWriter()).resolves.toMatchObject({ decision: 'allow', principal: { kind: 'staff_session', userId: 'u1', role: 'Менеджер' }, actor: 'staff:u1' })
    // An admin cookie and crm_user_id beside the staff cookie change nothing: the employee is the actor.
    asRequest({ [STAFF_COOKIE]: token, [INTEGRATION_ADMIN_SESSION_COOKIE]: admin, crm_user_id: 'u2' })
    await expect(resolveWriter()).resolves.toMatchObject({ decision: 'allow', actor: 'staff:u1' })
    // A mobile session beside the staff cookie: Identity Access answers no staff principal, so nobody writes.
    asRequest({ [STAFF_COOKIE]: token, [MOBILE_SESSION_COOKIE]: 'any-mobile-session' })
    await expect(resolveWriter()).resolves.toEqual({ decision: 'deny', reason: 'staff_session_refused' })
    // A mobile session alone is not a writer either.
    asRequest({ [MOBILE_SESSION_COOKIE]: 'any-mobile-session' })
    await expect(resolveWriter()).resolves.toEqual({ decision: 'deny', reason: 'no_session' })
    asRequest({ crm_user_id: 'u2' })
    await expect(resolveWriter()).resolves.toEqual({ decision: 'deny', reason: 'no_session' })
    writeRegistry([{ ...MANAGER, status: 'Отключен' }, ADMIN])
    asRequest({ [STAFF_COOKIE]: token })
    await expect(resolveWriter()).resolves.toEqual({ decision: 'deny', reason: 'staff_session_refused' })
  })
})

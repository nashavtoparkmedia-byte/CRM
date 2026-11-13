import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  reconcile: vi.fn(),
  principal: vi.fn(),
}))

vi.mock('@/modules/fleet-operations/public/v1', () => ({
  searchYandexParksByDriverQueryV1: mocks.search,
}))
vi.mock('@/modules/platform-shell/public/v1', () => ({
  reconcileYandexFleetWithAutomaticMergeV1: mocks.reconcile,
}))
vi.mock('@/modules/identity-access/public/v1', async importOriginal => ({
  ...await importOriginal<typeof import('@/modules/identity-access/public/v1')>(),
  getIntegrationAdminPrincipal: mocks.principal,
}))

import { RECONCILE_YANDEX_FLEET_COMMAND_V1 } from '@/contracts/fleet-operations/v1'
import { GET, POST } from './route'

const ROUTE = 'https://crm.example/api/monitoring/fleet-check/driver-person'

function postRequest(body: Record<string, unknown>, origin: string | null = 'https://crm.example') {
  const headers: Record<string, string> = { 'content-type': 'application/json', host: 'crm.example' }
  if (origin !== null) headers.origin = origin
  return new NextRequest(ROUTE, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function getRequest(query: string) {
  return new NextRequest(`${ROUTE}?query=${encodeURIComponent(query)}`, { method: 'GET' })
}

describe('fleet-check driver-person follow-up authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.search.mockResolvedValue({ clusters: [], errors: [], partial: false })
    mocks.reconcile.mockResolvedValue({ clusters: [], errors: [], partial: false })
    mocks.principal.mockResolvedValue({
      id: 'identity-access:integration-admin-session',
      kind: 'integration_admin_session',
    })
  })

  test('rejects unsigned and cross-origin follow-up before any reconciliation or merge', async () => {
    mocks.principal.mockResolvedValueOnce(null)

    const unauthorized = await POST(postRequest({ query: '+7 999 000-00-01' }))
    const crossOrigin = await POST(postRequest({ query: '+7 999 000-00-01' }, 'https://attacker.example'))

    expect(unauthorized.status).toBe(401)
    expect(crossOrigin.status).toBe(403)
    expect(mocks.principal).toHaveBeenCalledTimes(1)
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(mocks.search).not.toHaveBeenCalled()
  })

  test('rejects a request without an origin before consulting authorization', async () => {
    const response = await POST(postRequest({ query: '+7 999 000-00-01' }, null))

    expect(response.status).toBe(403)
    expect(mocks.principal).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  test('runs confirmation follow-up reconciliation only for a signed principal', async () => {
    const response = await POST(postRequest({ query: '1234567890' }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      reconciliation: { clusters: [], errors: [], partial: false },
    })
    expect(mocks.reconcile).toHaveBeenCalledTimes(1)
    expect(mocks.reconcile).toHaveBeenCalledWith({
      contract: RECONCILE_YANDEX_FLEET_COMMAND_V1,
      mode: 'confirmation_followup',
      query: '1234567890',
    })
  })

  test('validates the query only after authorization and never reconciles a short query', async () => {
    const response = await POST(postRequest({ query: 'ab' }))

    expect(response.status).toBe(400)
    expect(mocks.principal).toHaveBeenCalledTimes(1)
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  test('the GET search never runs the confirmation follow-up or a merge', async () => {
    const response = await GET(getRequest('Иванов Сергей'))

    expect(response.status).toBe(200)
    expect(mocks.search).toHaveBeenCalledWith('Иванов Сергей')
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })
})

/*
 * Security 2026-11-12 (Option B): the search changes state (Fleet's manual
 * reconciliation upserts Driver rows and Contacts cluster links), so it is
 * admitted exactly like its confirm POST: the signed integration-admin session
 * only. Every refusal answers before any Fleet call, so nothing is written.
 */
describe('GET driver-person search: who may run it and how much', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    mocks.search.mockResolvedValue({ checkedParks: 6, results: [], errors: [], clusters: [] })
    mocks.principal.mockResolvedValue({ id: 'identity-access:integration-admin-session', kind: 'integration_admin_session' })
  })

  async function freshGET() {
    vi.resetModules()
    return (await import('./route')).GET
  }

  function search(query: string, headers: Record<string, string> = {}) {
    return new NextRequest(`${ROUTE}?query=${encodeURIComponent(query)}`, { method: 'GET', headers })
  }

  test('without the integration-admin session nobody searches: no session, crm_user_id, a staff or a mobile cookie alone -> 401, zero Fleet calls', async () => {
    const run = await freshGET()
    mocks.principal.mockResolvedValue(null)
    for (const cookie of [undefined, 'crm_user_id=u1', 'yoko_staff_session=token', 'yoko_mobile_session=token']) {
      const response = await run(search('Иванов Сергей', cookie ? { cookie } : {}))
      expect(response.status).toBe(401)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({ error: 'Unauthorized' })
    }
    expect(mocks.search).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  test('a cross-site request is refused before the session is read', async () => {
    const run = await freshGET()
    for (const site of ['cross-site', 'same-site', 'none']) {
      const response = await run(search('Иванов Сергей', { 'sec-fetch-site': site }))
      expect(response.status).toBe(403)
    }
    expect(mocks.principal).not.toHaveBeenCalled()
    expect(mocks.search).not.toHaveBeenCalled()
    expect((await run(search('Иванов Сергей', { 'sec-fetch-site': 'same-origin' }))).status).toBe(200)
  })

  test('the query floor: 5 letters of a name, 7 digits of a phone, or a 6-character ВУ; at most 100 characters', async () => {
    const run = await freshGET()
    for (const query of ['ab', 'Ким', 'Ким С', '12345', '+7 999 12', 'A1234', 'x'.repeat(101)]) {
      const response = await run(search(query))
      expect(response.status).toBe(400)
      expect((await response.json()).code).toBe('QUERY_TOO_SHORT')
    }
    expect(mocks.search).not.toHaveBeenCalled()
    for (const query of ['Орлов', '+7 999 123', '99 11 100101', '77АВ12']) {
      vi.resetModules()
      const fresh = (await import('./route')).GET
      expect((await fresh(search(query))).status).toBe(200)
    }
  })

  test('one search in flight per principal: a second one while the first runs is 429', async () => {
    const run = await freshGET()
    let finish: (value: unknown) => void = () => undefined
    mocks.search.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = run(search('Иванов Сергей'))
    await vi.waitFor(() => expect(mocks.search).toHaveBeenCalledTimes(1))
    const second = await run(search('Петров Пётр'))
    expect(second.status).toBe(429)
    expect((await second.json()).code).toBe('SEARCH_IN_FLIGHT')
    finish({ checkedParks: 6, results: [], errors: [], clusters: [] })
    expect((await first).status).toBe(200)
    expect(mocks.search).toHaveBeenCalledTimes(1)
  })

  test('at most 6 searches a minute per principal; the 7th is 429 and calls nothing', async () => {
    const run = await freshGET()
    for (let index = 0; index < 6; index += 1) {
      expect((await run(search(`Иванов Сергей ${index}`))).status).toBe(200)
    }
    const seventh = await run(search('Иванов Сергей 7'))
    expect(seventh.status).toBe(429)
    expect((await seventh.json()).code).toBe('SEARCH_RATE_LIMITED')
    expect(seventh.headers.get('retry-after')).toBe('60')
    expect(mocks.search).toHaveBeenCalledTimes(6)
  })

  test('at most 20 searches a minute in all, whoever asks', async () => {
    const run = await freshGET()
    let answered = 0
    for (let principal = 0; principal < 4; principal += 1) {
      mocks.principal.mockResolvedValue({ id: `principal-${principal}`, kind: 'integration_admin_session' })
      for (let index = 0; index < 6; index += 1) {
        const response = await run(search(`Иванов Сергей ${principal}${index}`))
        if (response.status === 200) answered += 1
        else expect((await response.json()).code).toBe('SEARCH_RATE_LIMITED')
      }
    }
    expect(answered).toBe(20)
    expect(mocks.search).toHaveBeenCalledTimes(20)
  })

  test('the answer gives up at 15 s with 504, and the slot stays held until the search really ends', async () => {
    vi.useFakeTimers()
    const run = await freshGET()
    let finish: (value: unknown) => void = () => undefined
    mocks.search.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = run(search('Иванов Сергей'))
    await vi.advanceTimersByTimeAsync(15_000)
    const late = await pending
    expect(late.status).toBe(504)
    expect(late.headers.get('cache-control')).toBe('no-store')
    expect((await run(search('Петров Пётр'))).status).toBe(429)
    finish({ checkedParks: 6, results: [], errors: [], clusters: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect((await run(search('Петров Пётр'))).status).toBe(200)
    vi.useRealTimers()
  })

  test('a failed search answers 503 and no log line carries the query or the results', async () => {
    const run = await freshGET()
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mocks.search.mockRejectedValueOnce(new Error('Yandex down for Иванов Сергей 99 11 100101'))
    expect((await run(search('Иванов Сергей'))).status).toBe(503)
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/Иванов|100101/u)
    log.mockRestore()
  })
})

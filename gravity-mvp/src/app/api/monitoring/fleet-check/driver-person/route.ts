import { NextRequest, NextResponse } from 'next/server'

import { RECONCILE_YANDEX_FLEET_COMMAND_V1 } from '@/contracts/fleet-operations/v1'
import { resolveContactWriteAuthorityV1 } from '@/modules/contacts/public/v1'
import {
  searchYandexParksByDriverQueryV1,
} from '@/modules/fleet-operations/public/v1'
import {
  getIntegrationAdminPrincipal,
  isExactSameOriginMutationRequest,
} from '@/modules/identity-access/public/v1'
import { reconcileYandexFleetWithAutomaticMergeV1 } from '@/modules/platform-shell/public/v1'

const NO_STORE = { 'Cache-Control': 'no-store' }

/*
 * GET /api/monitoring/fleet-check/driver-person?query=…
 *
 * The «Привязать профиль Яндекс» search. It is not a read: Fleet's manual
 * reconciliation calls every configured park live (one page each for a text
 * query) and, under the reconciliation lease, upserts Driver rows and their
 * Contacts cluster links, which the confirm POST of /api/contacts/{id}/driver-person
 * then relies on. Its answer carries names, phones and the full ВУ.
 *
 * Security 2026-11-12 (Option B): it is admitted exactly like that confirm POST.
 * Since Contact Identity V2-B both ask Contacts' write authority: an employee's
 * own Staff Session of a reader role (recorded as staff:<id>), or transitionally
 * the integration-admin session; never a mobile session. A cross-site request (Sec-Fetch-Site other than
 * same-origin) is refused before anything else. Each request is bounded: a query
 * floor, one search in flight per principal, at most 6 a minute and 60 an hour
 * per principal and 20 a minute in all, and a 15 s answer deadline; the slot is
 * held until the search really ends. Nothing here logs the query or the results.
 */
const DEADLINE_MS = 15_000
const PER_PRINCIPAL_PER_MINUTE = 6
const PER_PRINCIPAL_PER_HOUR = 60
const GLOBAL_PER_MINUTE = 20
const MAX_QUERY_LENGTH = 100

const started: Array<{ key: string; at: number }> = []
const inFlight = new Set<string>()

type Admission = 'admitted' | 'busy' | 'throttled'

function admit(key: string, now: number): Admission {
  while (started.length > 0 && now - started[0].at >= 3_600_000) started.shift()
  if (inFlight.has(key)) return 'busy'
  const lastMinute = started.filter(entry => now - entry.at < 60_000)
  if (lastMinute.length >= GLOBAL_PER_MINUTE) return 'throttled'
  if (lastMinute.filter(entry => entry.key === key).length >= PER_PRINCIPAL_PER_MINUTE) return 'throttled'
  if (started.filter(entry => entry.key === key).length >= PER_PRINCIPAL_PER_HOUR) return 'throttled'
  started.push({ key, at: now })
  inFlight.add(key)
  return 'admitted'
}

/** A name of at least 5 letters, a phone of at least 7 digits, or a ВУ of at least 6 letters and digits. */
function searchableQuery(query: string): boolean {
  if (query.length < 3 || query.length > MAX_QUERY_LENGTH) return false
  const letters = (query.match(/\p{L}/gu) ?? []).length
  const digits = (query.match(/\p{Nd}/gu) ?? []).length
  return letters >= 5 || digits >= 7 || (letters > 0 && digits > 0 && letters + digits >= 6)
}

function answer(body: unknown, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } })
}

export async function GET(req: NextRequest) {
  const fetchSite = req.headers.get('sec-fetch-site')
  if (fetchSite !== null && fetchSite !== 'same-origin') return answer({ error: 'Forbidden' }, 403)
  const authority = await resolveContactWriteAuthorityV1()
  if (authority.decision !== 'allow') return answer({ error: 'Unauthorized' }, 401)

  const query = req.nextUrl.searchParams.get('query')?.trim() || ''
  if (!searchableQuery(query)) {
    return answer({ error: 'Введите не меньше 5 букв имени, 7 цифр телефона или номер ВУ.', code: 'QUERY_TOO_SHORT' }, 400)
  }

  const key = authority.actor
  const admission = admit(key, Date.now())
  if (admission !== 'admitted') {
    return answer({ error: 'Too Many Requests', code: admission === 'busy' ? 'SEARCH_IN_FLIGHT' : 'SEARCH_RATE_LIMITED' }, 429, { 'Retry-After': admission === 'busy' ? '5' : '60' })
  }
  const search = searchYandexParksByDriverQueryV1(query)
  // The slot is released when the search really ends, not when the answer gives up waiting.
  search.then(() => undefined, () => undefined).finally(() => { inFlight.delete(key) })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), DEADLINE_MS) })
  try {
    const outcome = await Promise.race([search, deadline])
    if (outcome === 'deadline') {
      console.error('[fleet-check/driver-person] search passed the answer deadline')
      return answer({ error: 'Gateway Timeout', code: 'SEARCH_DEADLINE' }, 504)
    }
    return answer(outcome, 200)
  } catch (error) {
    console.error('[fleet-check/driver-person] search failed:', error instanceof Error ? error.name : 'unknown')
    return answer({ error: 'Unavailable', code: 'SEARCH_FAILED' }, 503)
  } finally {
    clearTimeout(timer)
  }
}

export async function POST(req: NextRequest) {
  if (!isExactSameOriginMutationRequest(req)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (!await getIntegrationAdminPrincipal()) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const body = await req.json() as { query?: string }
  const query = body.query?.trim() || ''
  if (query.length < 3) {
    return NextResponse.json({ error: 'FIO, phone or VU query must contain at least 3 characters' }, { status: 400 })
  }
  const reconciliation = await reconcileYandexFleetWithAutomaticMergeV1({
    contract: RECONCILE_YANDEX_FLEET_COMMAND_V1,
    mode: 'confirmation_followup',
    query,
  })
  return NextResponse.json({ reconciliation })
}

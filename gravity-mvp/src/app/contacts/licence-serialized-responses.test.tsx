/**
 * The ВУ in the serialized answers of the D2 surfaces, under the Owner's rule of
 * 2026-11-11 (~10:20): every verified staff reader role — Администратор,
 * Руководитель, Менеджер — sees the full ВУ; nobody without a verified session
 * sees it, and no refusal, failure answer or log line carries it.
 *
 * These read the bytes a browser would receive, not a DTO: the card page is
 * rendered to HTML and the search route answers a real Request. Behind them run
 * the REAL compositions, the REAL Contacts read decision and the REAL Fleet
 * handlers; only Fleet's persistence holds a stored ВУ in memory.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORED = '99 12 345678'
const KEY = '9912345678'

const fixture = vi.hoisted(() => ({ role: 'Менеджер', fleetFails: false, fleetReads: 0 }))

// The card's client parts (V2) use the App Router; render them outside it.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: () => undefined, refresh: () => undefined, replace: () => undefined, back: () => undefined, forward: () => undefined, prefetch: () => undefined }),
}))

vi.mock('@/modules/platform-shell/public/v1', async () => {
  const { CONTACT_PERSON_CARD_RESULT_V1 } = await import('@/contracts/contacts/v1')
  const { DRIVER_PROFILES_FOR_CONTACTS_RESULT_V1 } = await import('@/contracts/fleet-operations/v1')
  const { CONTACT_CONVERSATIONS_RESULT_V1 } = await import('@/contracts/messaging/v1')
  const { decideContactReadAuthorityV1 } = await import('@/modules/contacts/public/v1/contact-read-authority')
  const { createContactPersonCardCompositionV1 } = await import('@/modules/platform-shell/application/contact-person-card-composition')
  const { createContactLicenceSearchCompositionV1 } = await import('@/modules/platform-shell/application/contact-licence-search-composition')
  const { createDriverProfilesForContactsHandlerV2 } = await import('@/modules/fleet-operations/public/v1/driver-profiles-for-contacts-v2-handler')
  const { createDriverProfilesForContactsHandlerV3 } = await import('@/modules/fleet-operations/public/v1/driver-profiles-for-contacts-v3-handler')
  const { createDriverProfilesByExactLicenceHandlerV1 } = await import('@/modules/fleet-operations/public/v1/driver-profiles-by-exact-licence-handler')

  const authority = async () => decideContactReadAuthorityV1({ staffCookie: 'present', staffPrincipal: { userId: 'u1', role: fixture.role } })
  // Fleet persistence: the STORED licence, exactly as a Driver row holds it.
  const licences = {
    async findLicencesOfDrivers(driverIds: readonly string[]) {
      fixture.fleetReads += 1
      return new Map(driverIds.map((id) => [id, '99 12 345678'] as [string, string | null]))
    },
    async findProfilesByLicenceKey(licenceKey: string) {
      fixture.fleetReads += 1
      if (fixture.fleetFails) throw new Error(`Driver read failed for ${licenceKey}`)
      return licenceKey !== '9912345678' ? [] : [{
        id: 'd-1', contactId: 'c-1', externalParkId: 'p-1', externalDriverProfileId: 'x-1', parkName: 'Парк Север',
        fullName: 'Громов Пётр', licenseNumber: '99 12 345678', dismissedAt: null,
      }]
    },
  }
  const readV1 = async (query: { subjects: Array<{ contactId: string }> }) => ({
    contract: DRIVER_PROFILES_FOR_CONTACTS_RESULT_V1,
    entries: query.subjects.map((subject) => ({
      contactId: subject.contactId,
      profiles: subject.contactId !== 'c-1' ? [] : [{
        driverId: 'd-1', linkBasis: 'contact_link' as const, linkedContactId: 'c-1', externalParkId: 'p-1', externalDriverProfileId: 'x-1',
        parkName: 'Парк Север', fullName: 'Громов Пётр', personResolutionStatus: 'vu_clustered' as const, personKeyType: 'normalized_vu' as const,
        sourceFreshness: 'fresh' as const, sourceState: 'current' as const, lastObservedAt: null, legalRole: null, workStatus: null,
        currentStatus: null, segment: null, dismissedAt: null,
      }],
    })),
  })
  const card = {
    contactId: 'c-1', displayName: 'Громов Пётр', displayTitle: 'Громов Пётр · +7 999 000-00-01', primaryPhone: '+7 999 000-00-01',
    displayNameSource: 'yandex', source: 'yandex',
    personConfirmation: { state: 'confirmed', confirmedPersonName: 'Громов Пётр', confirmedClusterKeyCount: 1, representativeDriverId: 'd-1' },
    mainDriverId: 'd-1', legacyYandexDriverId: null, phones: [], channels: [],
    lineage: { canonicalContactId: 'c-1', contactIds: ['c-1'], mergedFromCount: 0, mergeHistory: [] },
    conflicts: [], hasOpenConflict: false, hasPersonBlockingConflict: false, candidates: [],
    automation: { doNotMerge: false, canonicalPinned: false, mergeRecoveryState: null }, isArchived: false, linkHistory: [],
  }
  return {
    loadContactPersonCardV1: createContactPersonCardCompositionV1({
      async readContactPersonCard() {
        const answer = await authority()
        return answer.decision === 'allow'
          ? { contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'confirmed', card, licenceView: answer.licenceView } as never
          : { contract: CONTACT_PERSON_CARD_RESULT_V1, status: 'forbidden' }
      },
      readDriverProfilesForContacts: createDriverProfilesForContactsHandlerV3(
        createDriverProfilesForContactsHandlerV2(readV1 as never, licences),
        { async findCardFieldsOfDrivers(ids: readonly string[]) { return new Map(ids.map((id) => [id, { phone: '+79991000101', isSelfEmployed: true, employmentType: 'selfemployed' }])) } },
      ),
      readContactConversations: async () => ({ contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts: [] }) as never,
    }),
    searchPeopleByExactLicenceV1: createContactLicenceSearchCompositionV1({
      resolveReadAuthority: authority,
      findDriverProfilesByExactLicence: createDriverProfilesByExactLicenceHandlerV1(licences),
    }),
  }
})

const { default: ContactPersonPage } = await import('./[id]/page')
const { POST } = await import('./licence-search/route')

/** Every five-character run of the licence, however it is spaced: none may appear where no ВУ is due. */
const FULL_FRAGMENTS = Array.from({ length: KEY.length - 4 }, (_, index) => KEY.slice(index, index + 5))

function assertNoLicence(serialized: string, where: string) {
  const compact = serialized.replace(/\s|&nbsp;|&#x27;|&quot;|[-.() ]/gu, '')
  for (const fragment of FULL_FRAGMENTS) expect(compact, `${where} carries ${fragment}`).not.toContain(fragment)
}

async function cardHtml(): Promise<string> {
  return renderToStaticMarkup(await ContactPersonPage({ params: { id: 'c-1' } }))
}

function searchRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('https://yokoone.ru/contacts/licence-search', {
    method: 'POST',
    headers: { origin: 'https://yokoone.ru', host: 'yokoone.ru', 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

let logged: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fixture.role = 'Менеджер'
  fixture.fleetFails = false
  fixture.fleetReads = 0
  logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  assertNoLicence(JSON.stringify(logged.mock.calls), 'a log line')
  vi.restoreAllMocks()
})

describe('the «Карточка человека» HTML', () => {
  it('shows every staff reader role the stored ВУ in full', async () => {
    for (const role of ['Администратор', 'Руководитель', 'Менеджер']) {
      fixture.role = role
      expect(await cardHtml(), role).toContain(`ВУ ${STORED}`)
    }
  })

  it('a refused reader gets the sign-in screen, no ВУ and no Fleet read', async () => {
    fixture.role = 'Оператор'
    const html = await cardHtml()
    expect(html).toContain('Нет доступа к карточке человека')
    assertNoLicence(html, 'the refused card HTML')
    expect(fixture.fleetReads).toBe(0)
  })
})

describe('the «Люди» ВУ search JSON', () => {
  it('answers every staff reader role with the stored ВУ, never with the typed spelling', async () => {
    for (const role of ['Администратор', 'Руководитель', 'Менеджер']) {
      fixture.role = role
      for (const typed of [STORED, '9912345678', '99-12-345 678', '  9912 345678 ']) {
        const response = await POST(searchRequest({ licence: typed }))
        const text = await response.text()
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(JSON.parse(text)).toEqual({
          profiles: [{ driverId: 'd-1', linkedContactId: 'c-1', fullName: 'Громов Пётр', parkName: 'Парк Север', licence: STORED, dismissedAt: null }],
          truncated: false,
        })
        if (typed !== STORED) expect(text, `${role} echo of «${typed}»`).not.toContain(typed)
      }
    }
  })

  it('answers a too-short value exactly like a licence nobody holds', async () => {
    const unknown = await (await POST(searchRequest({ licence: '77 00 000000' }))).text()
    const short = await (await POST(searchRequest({ licence: '99123' }))).text()
    expect(unknown).toBe('{"profiles":[],"truncated":false}')
    expect(short).toBe(unknown)
  })

  it('no refusal or failure answer carries the typed licence', async () => {
    const cases: Array<[string, () => Promise<Response>, number]> = [
      ['a refused reader', async () => { fixture.role = 'Оператор'; return POST(searchRequest({ licence: STORED })) }, 401],
      ['a cross-site request', async () => POST(searchRequest({ licence: STORED }, { origin: 'https://evil.example' })), 403],
      ['a form post', async () => POST(searchRequest({ licence: STORED }, { 'content-type': 'application/x-www-form-urlencoded' })), 403],
      ['a broken body', async () => POST(searchRequest(`{"licence":"${STORED}"`)), 400],
      ['a non-string licence', async () => POST(searchRequest({ licence: [STORED] })), 400],
      ['an over-long value', async () => POST(searchRequest({ licence: `${KEY}${'0'.repeat(60)}` })), 400],
      ['a Fleet failure', async () => { fixture.fleetFails = true; return POST(searchRequest({ licence: STORED })) }, 503],
    ]
    for (const [name, call, status] of cases) {
      fixture.role = 'Менеджер'
      fixture.fleetFails = false
      const response = await call()
      expect(response.status, name).toBe(status)
      assertNoLicence(await response.text(), `the ${name} answer`)
    }
  })

  it('reads Fleet nothing for a refused or cross-site caller', async () => {
    fixture.role = 'Оператор'
    await POST(searchRequest({ licence: STORED }))
    fixture.role = 'Менеджер'
    await POST(searchRequest({ licence: STORED }, { origin: 'https://evil.example' }))
    expect(fixture.fleetReads).toBe(0)
  })
})

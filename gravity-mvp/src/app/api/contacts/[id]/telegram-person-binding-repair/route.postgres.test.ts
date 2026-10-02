import { NextRequest } from 'next/server'
import { ChatChannel } from '@prisma/client'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Route-level rehearsal of the bounded Telegram person-binding repair against a
 * real, isolated PostgreSQL database.
 *
 * This suite deliberately drives `POST /api/contacts/:id/telegram-person-binding-repair`
 * — the exact surface a future production execution will call — rather than the
 * Contacts capability directly. Everything below the route is real: the directed
 * contact merge runs in the genuine cross-owner merge transaction with its
 * ownership locks and postconditions, and `confirmDriverPersonV1` runs in its own
 * contact-ownership transaction. Only two seams are mocked, because neither can
 * be satisfied locally and neither is what these scenarios prove:
 *
 *   - integration-admin identity and same-origin (no HTTP request context here)
 *   - the Fleet-owned live park search (an outbound scraper call)
 *
 * Gating follows the repository convention for PostgreSQL suites: the whole
 * describe is skipped unless an isolated database URL is supplied, so `npm test`
 * stays hermetic.
 *
 *   docker run -d --name <pg> -p 127.0.0.1:<port>:5432 \
 *     -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=dacr postgres:16-alpine
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/dacr npx prisma db push
 *   DATABASE_URL=... TELEGRAM_BINDING_REPAIR_TEST_DATABASE_URL=... \
 *     npx vitest run src/app/api/contacts/\[id\]/telegram-person-binding-repair/route.postgres.test.ts
 */

const TEST_DATABASE_URL = process.env.TELEGRAM_BINDING_REPAIR_TEST_DATABASE_URL
const REQUIRE_DATABASE = process.env.REQUIRE_TELEGRAM_BINDING_REPAIR_DB_TESTS === '1'

if (REQUIRE_DATABASE && !TEST_DATABASE_URL) {
  throw new Error('TELEGRAM_BINDING_REPAIR_TEST_DATABASE_URL is required for the repair rehearsal')
}

const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip

// ── synthetic fixture ids and numbers; no production identifier appears here ──
const CANONICAL = 'pg-contact-canonical'
const DUPLICATE = 'pg-contact-duplicate'
const DRIVER_A = 'pg-driver-representative'
const DRIVER_B = 'pg-driver-other-person'
const YANDEX_A = 'pg-yandex-representative'
const YANDEX_B = 'pg-yandex-other-person'
const PHONE = '+79990000001'
const OTHER_PHONE = '+79990000009'
const TELEGRAM_ID = '700000001'
const IDENTITY = 'pg-identity-telegram'
const CHAT = 'pg-chat-telegram'
const PHONE_ROW = 'pg-phone-canonical-primary'
const CLUSTER_KEY = 'vu:PGTESTVU0001'
const OTHER_CLUSTER_KEY = 'vu:PGTESTVU0002'
const ACTOR = 'pg-integration-admin'

const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  sameOrigin: vi.fn(),
  fleetSearch: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }))
vi.mock('@/modules/identity-access/public/v1', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getIntegrationAdminPrincipal: mocks.principal,
  isExactSameOriginMutationRequest: mocks.sameOrigin,
}))
vi.mock('@/modules/fleet-operations/public/v1', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  searchYandexParksByDriverQueryV1: mocks.fleetSearch,
}))

import { prisma } from '@/lib/prisma'
import { isContactConfirmedMainDriverV1 } from '@/modules/contacts/public/v1'
import { POST } from './route'

/** The one authoritative Fleet cluster the repair is allowed to accept. */
function freshFleetEvidence() {
  return {
    checkedParks: 1,
    errors: [],
    clusters: [{
      profileClusterKey: CLUSTER_KEY,
      profiles: [{
        driverId: DRIVER_A,
        externalParkId: 'pg-park-1',
        externalDriverProfileId: 'pg-profile-1',
        fullName: 'Representative Driver',
        phones: [PHONE],
        normalizedVu: 'PGTESTVU0001',
        evidenceRoot: 'pg-park-1:pg-profile-1',
        sourceFreshness: 'fresh',
      }],
      warnings: [],
    }],
  }
}

function callRepair(body?: unknown) {
  const request = new NextRequest(
    `https://crm.test/api/contacts/${CANONICAL}/telegram-person-binding-repair`,
    {
      method: 'POST',
      body: JSON.stringify(body ?? { duplicateContactId: DUPLICATE, representativeDriverId: DRIVER_A }),
      headers: { 'Content-Type': 'application/json' },
    },
  )
  return POST(request, { params: Promise.resolve({ id: CANONICAL }) })
}

/**
 * The production before-state: one person owning two Contacts, and a Telegram
 * conversation on the duplicate that names a Driver belonging to someone else.
 */
async function seedBeforeState(options?: { canonicalCustomFields?: Record<string, unknown> }) {
  // `Contact.yandexDriverId` is a foreign key onto `Driver.yandexDriverId`, and
  // `Driver.contactId` points back, so the Drivers are created first and A is
  // linked to its Contact afterwards.
  await prisma.driver.createMany({
    data: [
      { id: DRIVER_A, yandexDriverId: YANDEX_A, fullName: 'Representative Driver', phone: PHONE },
      { id: DRIVER_B, yandexDriverId: YANDEX_B, fullName: 'Other Person', phone: OTHER_PHONE },
    ],
  })
  await prisma.contact.create({
    data: {
      id: CANONICAL,
      displayName: 'Canonical Person',
      yandexDriverId: YANDEX_A,
      customFields: (options?.canonicalCustomFields ?? {}) as never,
    },
  })
  await prisma.contact.create({ data: { id: DUPLICATE, displayName: 'Telegram Only' } })
  await prisma.driver.update({ where: { id: DRIVER_A }, data: { contactId: CANONICAL } })
  await prisma.contactPhone.create({
    data: {
      id: PHONE_ROW,
      contactId: CANONICAL,
      phone: PHONE,
      isPrimary: true,
      isActive: true,
      verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  })
  // The postconditions require the Contact to select its own active primary row.
  await prisma.contact.update({ where: { id: CANONICAL }, data: { primaryPhoneId: PHONE_ROW } })
  await prisma.driverTelegram.create({
    data: { driverId: DRIVER_A, telegramId: BigInt(TELEGRAM_ID), phoneVerified: false },
  })
  await prisma.contactIdentity.create({
    data: {
      id: IDENTITY,
      contactId: DUPLICATE,
      channel: ChatChannel.telegram,
      externalId: TELEGRAM_ID,
      isActive: true,
    },
  })
  await prisma.chat.create({
    data: {
      id: CHAT,
      channel: ChatChannel.telegram,
      chatType: 'private',
      externalChatId: `telegram:${TELEGRAM_ID}`,
      contactId: DUPLICATE,
      contactIdentityId: IDENTITY,
      // the defect: the conversation names a Driver who is a different human
      driverId: DRIVER_B,
    },
  })
}

type Confirmation = {
  id: string
  profileClusterKey: string
  representativeDriverId: string
  status: string
}

async function readState() {
  const [canonical, duplicate, chat, identity, merges] = await Promise.all([
    prisma.contact.findUnique({
      where: { id: CANONICAL },
      select: {
        isArchived: true,
        mainDriverId: true,
        mainDriverSelection: true,
        mainDriverSelectedBy: true,
        customFields: true,
      },
    }),
    prisma.contact.findUnique({
      where: { id: DUPLICATE },
      select: { isArchived: true, customFields: true },
    }),
    prisma.chat.findUnique({
      where: { id: CHAT },
      select: { contactId: true, contactIdentityId: true, driverId: true },
    }),
    prisma.contactIdentity.findUnique({ where: { id: IDENTITY }, select: { contactId: true } }),
    prisma.contactMerge.findMany({
      where: { OR: [{ survivorId: CANONICAL }, { survivorId: DUPLICATE }] },
      select: { survivorId: true, mergedId: true, action: true, mergedBy: true, reason: true },
    }),
  ])
  const fields = (canonical?.customFields ?? {}) as Record<string, unknown>
  const confirmations = (Array.isArray(fields.driverConfirmations)
    ? fields.driverConfirmations
    : []) as Confirmation[]
  const conflicts = (Array.isArray(fields.identityConflicts) ? fields.identityConflicts : []) as
    Array<Record<string, unknown>>
  return {
    canonical,
    duplicate,
    chat,
    identity,
    merges,
    confirmations,
    openConflicts: conflicts.filter(conflict => conflict.status === 'open'),
    duplicateRedirect: ((duplicate?.customFields ?? {}) as Record<string, unknown>).mergedIntoContactId,
    canonicalPinnedAt: fields.canonicalPinnedAt ?? null,
    canonicalPinnedBy: fields.canonicalPinnedBy ?? null,
  }
}

describeWithDatabase.sequential('POST telegram-person-binding-repair against PostgreSQL', () => {
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== TEST_DATABASE_URL) {
      throw new Error('DATABASE_URL must equal TELEGRAM_BINDING_REPAIR_TEST_DATABASE_URL')
    }
    const parsed = new URL(TEST_DATABASE_URL!)
    const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
    if (!isLoopback || !parsed.pathname.includes('dacr')) {
      throw new Error('the repair rehearsal refuses a non-local or non-dacr database')
    }
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.sameOrigin.mockReturnValue(true)
    mocks.principal.mockResolvedValue({ id: ACTOR })
    mocks.fleetSearch.mockResolvedValue(freshFleetEvidence())
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Chat", "ContactIdentity", "ContactPhone", "ContactMerge", '
      + '"DriverTelegram", "Driver", "Contact" CASCADE',
    )
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  // ── A. clean before-state → both phases commit ──────────────────────────────
  test('A: a clean P/T/A state reaches the exact expected final state', async () => {
    await seedBeforeState()

    const response = await callRepair()
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.status).toBe('REPAIRED')
    expect(payload.irreversible).toBe(true)
    expect(payload.result).toMatchObject({
      status: 'repaired',
      survivorContactId: CANONICAL,
      mergedContactId: DUPLICATE,
      chatId: CHAT,
      driverId: DRIVER_A,
    })
    // The route derived the Telegram peer from the duplicate's own identity, and
    // the person proof used the canonical verified primary phone.
    expect(mocks.fleetSearch).toHaveBeenCalledWith(PHONE.replace(/[^0-9]/g, ''))

    const state = await readState()
    // phase 1: the canonical Contact carries the operator's pin, which is what
    // makes the ordinary merge heuristic elect it (`manual_canonical_pin` is its
    // first comparison).
    expect(state.canonicalPinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(state.canonicalPinnedBy).toBe(ACTOR)
    // phase 2: the conversation belongs to the canonical Contact and names A
    expect(state.chat).toEqual({
      contactId: CANONICAL,
      contactIdentityId: IDENTITY,
      driverId: DRIVER_A,
    })
    expect(state.identity).toEqual({ contactId: CANONICAL })
    expect(state.duplicate?.isArchived).toBe(true)
    expect(state.duplicateRedirect).toBe(CANONICAL)
    expect(state.canonical?.isArchived).toBe(false)
    expect(state.merges).toEqual([{
      survivorId: CANONICAL,
      mergedId: DUPLICATE,
      action: 'merge',
      mergedBy: ACTOR,
      reason: 'manual',
    }])
    // phase 3: the representative Driver is the confirmed main Driver
    expect(state.canonical?.mainDriverId).toBe(DRIVER_A)
    expect(state.canonical?.mainDriverSelection).toBe('manual')
    expect(state.canonical?.mainDriverSelectedBy).toBe(ACTOR)
    expect(state.confirmations).toHaveLength(1)
    expect(state.confirmations[0]).toMatchObject({
      profileClusterKey: CLUSTER_KEY,
      representativeDriverId: DRIVER_A,
      status: 'confirmed',
    })
    expect(state.openConflicts).toHaveLength(0)
    // the end the whole repair exists for: authority now resolves
    await expect(isContactConfirmedMainDriverV1(CANONICAL, DRIVER_A)).resolves.toBe(true)
  })

  // ── B. phase 2 fails → deny-only intermediate state → resume, no re-merge ───
  test('B: failure after phase 1 leaves a deny-only state that a second call resumes', async () => {
    // A pre-existing confirmed confirmation for a DIFFERENT cluster makes the
    // real `confirmDriverPersonV1` answer `contradiction`. No injected fault:
    // phase 2 fails through production code.
    await seedBeforeState({
      canonicalCustomFields: {
        driverConfirmations: [{
          id: 'pg-preexisting-confirmation',
          profileClusterKey: OTHER_CLUSTER_KEY,
          representativeDriverId: DRIVER_B,
          status: 'confirmed',
          confirmedBy: 'pg-earlier-operator',
          confirmationBasis: 'phone',
          searchInput: OTHER_PHONE,
          evidenceRoot: `operator-confirmation:${CANONICAL}:${OTHER_CLUSTER_KEY}`,
          evidenceSnapshot: { profiles: [], warnings: [] },
          confirmedAt: '2026-09-01T00:00:00.000Z',
          lastReconciledAt: null,
        }],
        confirmedDriverClusterKeys: [OTHER_CLUSTER_KEY],
      },
    })

    const first = await callRepair()
    const firstPayload = await first.json()
    expect(first.status).toBe(409)
    expect(firstPayload.status).toBe('PHASE_1_COMPLETE_CONFIRMATION_PENDING')
    expect(firstPayload.retryResumesPhase2).toBe(true)
    expect(firstPayload.result.status).toBe('merged_pending_confirmation')

    // Intermediate state: phase 1 committed, phase 2 did not, and NO authority
    // was granted — exactly the deny-only shape the phase model promises.
    const intermediate = await readState()
    expect(intermediate.chat).toEqual({
      contactId: CANONICAL,
      contactIdentityId: IDENTITY,
      driverId: DRIVER_A,
    })
    expect(intermediate.duplicate?.isArchived).toBe(true)
    expect(intermediate.merges).toHaveLength(1)
    expect(intermediate.canonical?.mainDriverId).toBeNull()
    expect(intermediate.canonical?.mainDriverSelection).toBe('auto')
    expect(intermediate.confirmations.map(item => item.profileClusterKey)).toEqual([OTHER_CLUSTER_KEY])
    expect(intermediate.canonicalPinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await expect(isContactConfirmedMainDriverV1(CANONICAL, DRIVER_A)).resolves.toBe(false)

    // The operator resolves the unrelated pre-existing contradiction — outside
    // this repair's scope — and re-invokes the same route. The canonical pin is
    // left in place, as a resuming operator would leave it.
    await prisma.contact.update({
      where: { id: CANONICAL },
      data: {
        customFields: {
          canonicalPinnedAt: intermediate.canonicalPinnedAt,
          canonicalPinnedBy: intermediate.canonicalPinnedBy,
        } as never,
      },
    })

    const second = await callRepair()
    const secondPayload = await second.json()
    expect(second.status).toBe(200)
    expect(secondPayload.status).toBe('REPAIRED')

    const resumed = await readState()
    // The decisive assertion: resuming confirmed, and did NOT merge a second time.
    expect(resumed.merges).toHaveLength(1)
    expect(resumed.merges[0]).toMatchObject({ survivorId: CANONICAL, mergedId: DUPLICATE })
    expect(resumed.canonical?.mainDriverId).toBe(DRIVER_A)
    expect(resumed.confirmations).toHaveLength(1)
    expect(resumed.confirmations[0]).toMatchObject({
      profileClusterKey: CLUSTER_KEY,
      representativeDriverId: DRIVER_A,
      status: 'confirmed',
    })
    await expect(isContactConfirmedMainDriverV1(CANONICAL, DRIVER_A)).resolves.toBe(true)
  })

  // ── C. replay of a successful repair is a no-op ──────────────────────────────
  test('C: replaying a completed repair mutates nothing', async () => {
    await seedBeforeState()
    expect((await callRepair()).status).toBe(200)
    const after = await readState()

    const replay = await callRepair()
    const payload = await replay.json()
    expect(replay.status).toBe(200)
    expect(payload.status).toBe('ALREADY_REPAIRED')

    const afterReplay = await readState()
    expect(afterReplay).toEqual(after)
    expect(afterReplay.merges).toHaveLength(1)
    expect(afterReplay.confirmations).toHaveLength(1)
  })

  // ── D. concurrent invocations elect exactly one mutation owner ──────────────
  test('D: concurrent requests produce one repair and one merge ledger row', async () => {
    await seedBeforeState()

    const responses = await Promise.all([callRepair(), callRepair()])
    const payloads = await Promise.all(responses.map(response => response.json()))
    const repaired = payloads.filter(payload => payload.status === 'REPAIRED')

    expect(repaired).toHaveLength(1)
    // The loser must fail closed or observe the completed repair; it may never
    // report a second repair of its own.
    const loser = payloads.find(payload => payload.status !== 'REPAIRED')!
    expect(['ALREADY_REPAIRED', 'PRECONDITION_FAILED', 'PHASE_1_COMPLETE_CONFIRMATION_PENDING'])
      .toContain(loser.status)
    expect(loser.result?.status).not.toBe('repaired')

    const state = await readState()
    expect(state.merges).toHaveLength(1)
    expect(state.chat).toEqual({
      contactId: CANONICAL,
      contactIdentityId: IDENTITY,
      driverId: DRIVER_A,
    })
    expect(state.canonical?.mainDriverId).toBe(DRIVER_A)
    expect(state.confirmations).toHaveLength(1)
    await expect(isContactConfirmedMainDriverV1(CANONICAL, DRIVER_A)).resolves.toBe(true)
  })
})

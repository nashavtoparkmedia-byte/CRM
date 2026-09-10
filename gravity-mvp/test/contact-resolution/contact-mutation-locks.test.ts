import type { Prisma } from '@prisma/client'
import { execFileSync } from 'node:child_process'
import { NextRequest } from 'next/server'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { POST as addPhoneRoute } from '@/app/api/contacts/[id]/phones/route'
import {
  DELETE as deletePhoneRoute,
  PATCH as patchPhoneRoute,
} from '@/app/api/contacts/[id]/phones/[phoneId]/route'
import { manageContactPhoneEvidenceV1 } from '@/modules/contacts/public/v1/contact-phone-evidence'

import {
  CONTACT_OWNERSHIP_ADVISORY_CLASS_ID,
  CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID,
  ContactOwnershipBusyError,
  ContactOwnershipInvariantError,
  admitContactOwnershipTransaction,
  assertContactOwnershipPostconditions,
} from '@/modules/contacts/internal/contact-ownership-coordinator'

vi.mock('@/modules/contacts/public/v1/contact-phone-evidence', () => ({
  manageContactPhoneEvidenceV1: vi.fn(),
}))
vi.mock('@/modules/identity-access/public/v1', async importOriginal => ({
  ...await importOriginal<typeof import('@/modules/identity-access/public/v1')>(),
  getIntegrationAdminPrincipal: vi.fn(async () => ({
    id: 'identity-access:integration-admin-session',
    kind: 'integration_admin_session',
  })),
}))

const HISTORICAL_RESOLVER_SHA = '0af09758de2b7b9df88169aa2f7e5d93868c7e05'
const HISTORICAL_PHONE_SHA = 'bc44093c099e7099ba67cbd0fb11bb4e5c3148ba'

function gitText(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim()
}

function exactHistoricalSource(commit: string, file: string): {
  commit: string
  tree: string
  blob: string
  source: string
} {
  const observedCommit = gitText('rev-parse', `${commit}^{commit}`)
  return {
    commit: observedCommit,
    tree: gitText('rev-parse', `${observedCommit}^{tree}`),
    blob: gitText('rev-parse', `${observedCommit}:${file}`),
    source: gitText('show', `${observedCommit}:${file}`),
  }
}

function recordHistoricalRejection(record: Record<string, string>): void {
  console.info(`CONTACT_OWNERSHIP_HISTORICAL_REJECTION ${JSON.stringify(record)}`)
}

describe('exact historical ownership negative controls', () => {
  test('0af09758 rejects the pre-admission authoritative resolution plan', () => {
    const file = 'gravity-mvp/src/lib/contacts/SafeContactResolutionExecutor.ts'
    const observed = exactHistoricalSource(HISTORICAL_RESOLVER_SHA, file)
    expect(observed).toMatchObject({
      commit: HISTORICAL_RESOLVER_SHA,
      tree: '79ea3077ee3822874efda77669f4fb67acf17784',
      blob: '4e0fb86d74e2472fbcabdf1784117646a88af629',
    })

    const rejectHistoricalResolver = () => {
      const plan = observed.source.indexOf('const initialPlan = await this.planner.resolve(input)')
      const transaction = observed.source.indexOf('return this.unitOfWork.run(async transaction =>')
      if (plan >= 0 && transaction >= 0 && plan < transaction
        && observed.source.includes('LOCK TABLE "Contact" IN EXCLUSIVE MODE')
        && !observed.source.includes('pg_advisory_xact_lock')) {
        throw new Error('authoritative resolution plan occurs before CNT1 admission')
      }
    }
    expect(rejectHistoricalResolver).toThrow('authoritative resolution plan occurs before CNT1 admission')
    recordHistoricalRejection({
      expected_sha: HISTORICAL_RESOLVER_SHA,
      observed_sha: observed.commit,
      tree: observed.tree,
      blob: observed.blob,
      mechanism: 'exact git object source-order analyzer',
      expected_defect: 'authoritative plan before global admission',
      observed_failure: 'authoritative resolution plan occurs before CNT1 admission',
    })
  })

  test('bc44093c rejects phone eligibility read before late relation locks', () => {
    const routeFile = 'gravity-mvp/src/app/api/contacts/[id]/phones/[phoneId]/route.ts'
    const serviceFile = 'gravity-mvp/src/lib/ContactService.ts'
    const route = exactHistoricalSource(HISTORICAL_PHONE_SHA, routeFile)
    const service = exactHistoricalSource(HISTORICAL_PHONE_SHA, serviceFile)
    expect(route).toMatchObject({
      commit: HISTORICAL_PHONE_SHA,
      tree: '8333148b668e61cd628e3d6ebf29435b6b5b221b',
      blob: '64b5d875bff1e0a05c33e8c93a10790e2c466d0e',
    })
    expect(service.blob).toBe('06371d3ab271ad932ba99208c7159137a5bbd51e')

    const rejectHistoricalPhoneRoute = () => {
      const preflight = route.source.indexOf('const phone = await prisma.contactPhone.findFirst')
      const transaction = route.source.indexOf('await prisma.$transaction')
      if (preflight >= 0 && transaction >= 0 && preflight < transaction
        && route.source.includes("await acquireContactMutationLocks(tx, ['phone'])")
        && service.source.includes('LOCK TABLE "ContactPhone" IN ROW EXCLUSIVE MODE')
        && !service.source.includes('pg_advisory_xact_lock')) {
        throw new Error('phone eligibility is read before admission and only late relation locks follow')
      }
    }
    expect(rejectHistoricalPhoneRoute).toThrow(
      'phone eligibility is read before admission and only late relation locks follow',
    )
    recordHistoricalRejection({
      expected_sha: HISTORICAL_PHONE_SHA,
      observed_sha: route.commit,
      tree: route.tree,
      blob: `${route.blob},${service.blob}`,
      mechanism: 'exact git object source-order analyzer',
      expected_defect: 'stale phone preflight before mutation admission',
      observed_failure: 'phone eligibility read precedes late relation locks',
    })
  })
})

describe('Contacts advisory admission namespace', () => {
  test('uses documented readable two-int32 YOKO/CNT1 keys', () => {
    expect(CONTACT_OWNERSHIP_ADVISORY_CLASS_ID).toBe(0x594f4b4f)
    expect(CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID).toBe(0x434e5431)
  })

  test('performs bounded timeout setup and xact admission in one first statement', async () => {
    const query = vi.fn(async () => [{ admitted: true }])
    const transaction = { $queryRaw: query } as unknown as Prisma.TransactionClient

    await admitContactOwnershipTransaction(transaction, { lockTimeoutMs: 321 })

    expect(query).toHaveBeenCalledOnce()
    const [strings, ...values] = query.mock.calls[0] as unknown as [readonly string[], ...unknown[]]
    expect(strings.join(' ')).toContain('set_config')
    expect(strings.join(' ')).toContain('pg_advisory_xact_lock')
    expect(values).toContain('321ms')
    expect(values).toContain(CONTACT_OWNERSHIP_ADVISORY_CLASS_ID)
    expect(values).toContain(CONTACT_OWNERSHIP_ADVISORY_OBJECT_ID)
  })
})

type PrimaryFixture = 'valid-empty' | 'pointer-without-flag' | 'flag-without-pointer'

function primaryFixtureTransaction(fixture: PrimaryFixture): Prisma.TransactionClient {
  return {
    $queryRaw: vi.fn(async (statement: readonly string[] | { strings: readonly string[] }) => {
      const sql = ('strings' in statement ? statement.strings : statement).join(' ')
      if (sql.includes('pg_advisory_xact_lock')) return [{ admitted: true }]
      if (sql.includes('LEFT JOIN "ContactPhone" AS phone')) {
        return fixture === 'pointer-without-flag' ? [{ id: 'contact-1' }] : []
      }
      if (sql.includes('contact."primaryPhoneId" <> phone.id')) {
        return fixture === 'flag-without-pointer'
          ? [{ id: 'phone-1', contactId: 'contact-1' }]
          : []
      }
      return []
    }),
  } as unknown as Prisma.TransactionClient
}

const primaryScope = {
  contactIds: ['contact-1'],
  phoneIds: ['phone-1'],
  normalizedPhones: [],
  identityIds: [],
  mergeIds: [],
}

describe('Contacts primary pointer/flag postcondition', () => {
  test('uses physical mapped table names for archived foreign-reference checks', async () => {
    const query = vi.fn(async (statement: readonly string[] | { strings: readonly string[] }) => {
      void statement
      return []
    })
    const transaction = { $queryRaw: query } as unknown as Prisma.TransactionClient
    await admitContactOwnershipTransaction(transaction)
    await assertContactOwnershipPostconditions(transaction, primaryScope)
    const sql = query.mock.calls.map(([statement]) => (
      'strings' in statement ? statement.strings : statement
    ).join(' ')).join('\n')
    expect(sql).toContain('FROM "tasks" AS task')
    expect(sql).not.toContain('FROM "Task" AS task')
  })

  test('allows a Contact with neither a primary pointer nor an active primary flag', async () => {
    const transaction = primaryFixtureTransaction('valid-empty')
    await admitContactOwnershipTransaction(transaction)
    await expect(assertContactOwnershipPostconditions(transaction, primaryScope)).resolves.toBeUndefined()
  })

  test('rejects a non-null pointer whose phone is not an active primary', async () => {
    const transaction = primaryFixtureTransaction('pointer-without-flag')
    await admitContactOwnershipTransaction(transaction)
    await expect(assertContactOwnershipPostconditions(transaction, primaryScope))
      .rejects.toBeInstanceOf(ContactOwnershipInvariantError)
  })

  test('rejects an active primary flag when Contact.primaryPhoneId is null or different', async () => {
    const transaction = primaryFixtureTransaction('flag-without-pointer')
    await admitContactOwnershipTransaction(transaction)
    await expect(assertContactOwnershipPostconditions(transaction, primaryScope))
      .rejects.toBeInstanceOf(ContactOwnershipInvariantError)
  })
})

const busyBody = {
  error: 'CONTACT_OWNERSHIP_BUSY',
  message: 'Contact is being updated. Retry shortly.',
  retryable: true,
}

async function expectBusyResponse(response: Response): Promise<void> {
  expect(response.status).toBe(503)
  expect(response.headers.get('retry-after')).toBe('2')
  expect(response.headers.get('cache-control')).toBe('no-store')
  await expect(response.json()).resolves.toEqual(busyBody)
}

describe('public phone route coordinator busy contract', () => {
  afterEach(() => vi.restoreAllMocks())

  test('POST maps only the typed coordinator timeout to a retryable 503', async () => {
    vi.mocked(manageContactPhoneEvidenceV1)
      .mockRejectedValueOnce(new ContactOwnershipBusyError())
    const response = await addPhoneRoute(
      new NextRequest('http://localhost/api/contacts/contact-1/phones', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'localhost',
          origin: 'http://localhost',
        },
        body: JSON.stringify({ phone: '+79990000001', isPrimary: true }),
      }),
      { params: Promise.resolve({ id: 'contact-1' }) },
    )
    await expectBusyResponse(response)
  })

  test('PATCH maps the coordinator timeout before any response readback', async () => {
    vi.mocked(manageContactPhoneEvidenceV1)
      .mockRejectedValueOnce(new ContactOwnershipBusyError())
    const response = await patchPhoneRoute(
      new NextRequest('http://localhost/api/contacts/contact-1/phones/phone-1', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          host: 'localhost',
          origin: 'http://localhost',
        },
        body: JSON.stringify({ isPrimary: true }),
      }),
      { params: Promise.resolve({ id: 'contact-1', phoneId: 'phone-1' }) },
    )
    await expectBusyResponse(response)
  })

  test('DELETE maps the coordinator timeout without reporting a false success', async () => {
    vi.mocked(manageContactPhoneEvidenceV1)
      .mockRejectedValueOnce(new ContactOwnershipBusyError())
    const response = await deletePhoneRoute(
      new NextRequest('http://localhost/api/contacts/contact-1/phones/phone-1', {
        method: 'DELETE',
        headers: { host: 'localhost', origin: 'http://localhost' },
      }),
      { params: Promise.resolve({ id: 'contact-1', phoneId: 'phone-1' }) },
    )
    await expectBusyResponse(response)
  })

  test('unexpected PATCH and DELETE failures are not mislabeled as coordinator busy', async () => {
    const unexpectedPatch = new Error('unexpected patch failure')
    vi.mocked(manageContactPhoneEvidenceV1).mockRejectedValueOnce(unexpectedPatch)
    await expect(patchPhoneRoute(
      new NextRequest('http://localhost/api/contacts/contact-1/phones/phone-1', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          host: 'localhost',
          origin: 'http://localhost',
        },
        body: JSON.stringify({ isPrimary: true }),
      }),
      { params: Promise.resolve({ id: 'contact-1', phoneId: 'phone-1' }) },
    )).rejects.toBe(unexpectedPatch)

    const unexpectedDelete = new Error('unexpected delete failure')
    vi.mocked(manageContactPhoneEvidenceV1).mockRejectedValueOnce(unexpectedDelete)
    await expect(deletePhoneRoute(
      new NextRequest('http://localhost/api/contacts/contact-1/phones/phone-1', {
        method: 'DELETE',
        headers: { host: 'localhost', origin: 'http://localhost' },
      }),
      { params: Promise.resolve({ id: 'contact-1', phoneId: 'phone-1' }) },
    )).rejects.toBe(unexpectedDelete)
  })
})

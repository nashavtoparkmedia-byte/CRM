import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  confirm: vi.fn(),
  merge: vi.fn(),
  reconcile: vi.fn(),
  search: vi.fn(),
}))

vi.mock('@/modules/contacts/public/v1', () => ({ confirmDriverPersonV1: mocks.confirm }))
vi.mock('@/modules/fleet-operations/public/v1', () => ({
  normalizeDriverLicenceVuV1: (value: unknown) => String(value ?? '').replace(/\D/g, ''),
  normalizeParkPhoneDigitsV1: (value: unknown) => String(value ?? '').replace(/\D/g, ''),
  searchYandexParksByDriverQueryV1: mocks.search,
}))
vi.mock('@/modules/identity-access/public/v1', async importOriginal => ({
  ...await importOriginal<typeof import('@/modules/identity-access/public/v1')>(),
  getIntegrationAdminPrincipal: mocks.principal,
}))
vi.mock('@/modules/platform-shell/internal/contact-park-merge-orchestrator', () => ({
  attemptAutomaticContactMergeFromPlatformV1: mocks.merge,
}))
vi.mock('@/modules/platform-shell/public/v1', () => ({
  reconcileYandexFleetWithAutomaticMergeV1: mocks.reconcile,
}))

import { POST } from './route'

const freshProfile = {
  driverId: 'driver-1',
  externalParkId: 'park-1',
  externalDriverProfileId: 'profile-1',
  fullName: 'Иванов Иван',
  phones: ['+79990000001'],
  normalizedVu: '1234567890',
  evidenceRoot: 'yandex:park-1:profile-1:fresh-observation',
  sourceFreshness: 'fresh' as const,
}

function authorityCluster(overrides: Record<string, unknown> = {}) {
  return {
    profileClusterKey: 'vu:1234567890',
    normalizedVu: '1234567890',
    contactId: null,
    contactMergeCandidateIds: [],
    profileIds: ['driver-1'],
    profiles: [freshProfile],
    warnings: [],
    ...overrides,
  }
}

function authorityResult(overrides: Record<string, unknown> = {}) {
  return {
    checkedParks: 2,
    results: [],
    errors: [],
    clusters: [authorityCluster()],
    ...overrides,
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return new NextRequest('https://crm.example/api/contacts/contact-a/driver-person', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      host: 'crm.example',
      origin: 'https://crm.example',
      'x-crm-user-id': 'forged-header-actor',
    },
    body: JSON.stringify({
      profileClusterKey: 'vu:1234567890',
      representativeDriverId: 'driver-1',
      searchInput: '1234567890',
      confirmedBy: 'forged-body-actor',
      confirmationBasis: 'fio',
      profiles: [{ ...freshProfile, driverId: 'forged-evidence-driver' }],
      warnings: ['forged-client-warning'],
      ...overrides,
    }),
  })
}

const context = { params: Promise.resolve({ id: 'contact-a' }) }

describe('Driver-person confirmation orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.principal.mockResolvedValue({
      id: 'identity-access:integration-admin-session',
      kind: 'integration_admin_session',
    })
    mocks.search.mockResolvedValue(authorityResult())
    mocks.reconcile.mockResolvedValue({ clusters: [], errors: [], partial: false })
  })

  test('persists only fresh server-derived evidence and runs the coordinated Fleet follow-up', async () => {
    mocks.confirm.mockResolvedValue({
      status: 'confirmed', confirmationId: 'confirmation-1', contactId: 'contact-a',
      profileClusterKey: 'vu:1234567890',
    })

    const response = await POST(request(), context)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mocks.search).toHaveBeenCalledWith('1234567890')
    expect(mocks.confirm).toHaveBeenCalledWith({
      contract: 'contacts.ConfirmDriverPersonCommand.v1',
      contactId: 'contact-a',
      profileClusterKey: 'vu:1234567890',
      representativeDriverId: 'driver-1',
      confirmedBy: 'identity-access:integration-admin-session',
      confirmationBasis: 'vu',
      searchInput: '1234567890',
      evidenceSnapshot: { profiles: [freshProfile], warnings: [] },
    })
    expect(mocks.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      contract: 'fleet_operations.ReconcileYandexFleetCommand.v1',
      mode: 'confirmation_followup',
      query: '1234567890',
    }))
    expect(body.confirmation.status).toBe('confirmed')
  })

  test('requires a signed integration-admin principal before querying or mutating', async () => {
    mocks.principal.mockResolvedValue(null)

    const response = await POST(request(), context)

    expect(response.status).toBe(401)
    expect(mocks.search).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.merge).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  test('rejects cross-origin confirmation before authorization or provider access', async () => {
    const forgedRequest = request()
    forgedRequest.headers.set('origin', 'https://attacker.example')

    const response = await POST(forgedRequest, context)

    expect(response.status).toBe(403)
    expect(mocks.principal).not.toHaveBeenCalled()
    expect(mocks.search).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.merge).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  test.each([
    ['cluster', { profileClusterKey: 'vu:forged-cluster' }],
    ['representative Driver', { representativeDriverId: 'forged-driver' }],
  ])('rejects a forged %s before any confirmation mutation', async (_label, override) => {
    const response = await POST(request(override), context)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'Confirmation candidate is stale; search again' })
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.merge).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  test('rejects stale cluster evidence before any confirmation mutation', async () => {
    mocks.search.mockResolvedValue(authorityResult({
      clusters: [authorityCluster({
        profiles: [{ ...freshProfile, sourceFreshness: 'stale' }],
      })],
    }))

    const response = await POST(request(), context)

    expect(response.status).toBe(409)
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.merge).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  test('rejects incomplete all-park coverage before any confirmation mutation', async () => {
    mocks.search.mockResolvedValue(authorityResult({
      errors: [{ parkId: 'park-2', parkName: 'Park 2', message: 'timeout' }],
    }))

    const response = await POST(request(), context)

    expect(response.status).toBe(503)
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.merge).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })

  test('returns committed policy denial without a second contradiction mutation', async () => {
    mocks.confirm.mockResolvedValue({
      status: 'needs_reconciliation', confirmationId: 'confirmation-1', contactId: 'contact-a',
      profileClusterKey: 'vu:1234567890', mergeCandidateContactId: 'contact-b',
    })
    mocks.merge.mockResolvedValue({ status: 'policy_blocked', reason: 'workflow_collision' })

    const response = await POST(request(), context)
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(mocks.merge).toHaveBeenCalledWith('contact-a', 'contact-b')
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(body).toMatchObject({
      error: 'Manual reconciliation required',
      confirmation: { status: 'needs_reconciliation' },
      automaticMerge: { status: 'policy_blocked', reason: 'workflow_collision' },
    })
  })

  test('uses the deterministic survivor before Fleet reconciliation', async () => {
    mocks.confirm.mockResolvedValue({
      status: 'needs_reconciliation', confirmationId: 'confirmation-1', contactId: 'contact-a',
      profileClusterKey: 'vu:1234567890', mergeCandidateContactId: 'contact-b',
    })
    mocks.merge.mockResolvedValue({ status: 'merged', survivorContactId: 'contact-b' })

    const body = await (await POST(request(), context)).json()

    expect(body.confirmation).toMatchObject({ status: 'confirmed', contactId: 'contact-b' })
    expect(mocks.reconcile).toHaveBeenCalledOnce()
  })
})

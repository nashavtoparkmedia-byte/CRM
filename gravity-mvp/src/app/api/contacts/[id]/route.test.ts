import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  contactFindUnique: vi.fn(),
  driverFindMany: vi.fn(),
  lineage: vi.fn(),
  summary: vi.fn(),
  contactUpdate: vi.fn(),
  patchContact: vi.fn(),
  principal: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    contact: { findUnique: mocks.contactFindUnique, update: mocks.contactUpdate },
    driver: { findMany: mocks.driverFindMany },
  },
}))
vi.mock('@/lib/ContactService', () => ({
  ContactService: { patchContact: mocks.patchContact },
}))
vi.mock('@/modules/contacts/public/v1', () => ({ resolveContactLineageV1: mocks.lineage }))
vi.mock('@/modules/identity-access/public/v1', async importOriginal => ({
  ...await importOriginal<typeof import('@/modules/identity-access/public/v1')>(),
  getIntegrationAdminPrincipal: mocks.principal,
}))
vi.mock('@/modules/contacts/public/v1/contact-display-policy', () => ({
  buildCanonicalContactSummary: mocks.summary,
}))

import { GET, PATCH } from './route'

const context = { params: Promise.resolve({ id: 'contact-1' }) }

function patchRequest(body: unknown, origin = 'https://crm.example') {
  return new NextRequest('https://crm.example/api/contacts/contact-1', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      host: 'crm.example',
      origin,
      'x-crm-user-id': 'forged-header-actor',
    },
    body: JSON.stringify(body),
  })
}

function driver(id: string, parkId: string, profileId: string) {
  return {
    id,
    fullName: 'Иванов Иван',
    phone: '+79990000001',
    segment: 'active',
    score: null,
    lastOrderAt: null,
    hiredAt: null,
    dismissedAt: null,
    externalParkId: parkId,
    externalDriverProfileId: profileId,
    externalPersonKey: 'vu:1234567890',
    personKeyType: 'normalized_vu',
    personResolutionStatus: 'vu_clustered',
    personResolutionBasis: 'normalized_vu',
    licenseNumber: '12 34 567890',
    customFields: {
      fleetSource: {
        sourceFreshness: 'fresh', sourceState: 'current', sourcePhones: ['+79990000001'],
        sourceDates: { modifiedDate: '2026-09-01' }, sourceMetadata: {},
      },
    },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    park: { id: `local-${parkId}`, parkName: parkId, externalParkId: parkId },
  }
}

describe('Contact evidence GET', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.summary.mockReturnValue({ displayTitle: 'Иванов Иван' })
    mocks.lineage.mockResolvedValue({ contactIds: ['contact-1', 'merged-contact'] })
    mocks.driverFindMany.mockResolvedValue([driver('driver-b', 'park-b', 'profile-b')])
    mocks.principal.mockResolvedValue({
      id: 'identity-access:integration-admin-session',
      kind: 'integration_admin_session',
    })
    mocks.contactFindUnique.mockResolvedValue({
      id: 'contact-1',
      displayName: 'Иванов Иван',
      displayNameSource: 'driver',
      masterSource: 'chat',
      yandexDriverId: null,
      primaryPhoneId: 'phone-1',
      notes: null,
      tags: [],
      customFields: {
        identityConflicts: [{
          identityId: 'identity-inactive',
          conflictType: 'provider_account_identity_collision',
          status: 'open',
        }],
      },
      isArchived: false,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      phones: [{
        id: 'phone-1', phone: '+79990000001', label: null, isPrimary: true,
        source: 'telegram', isActive: true, verifiedAt: null, isTemporary: false,
        expiresAt: null, createdAt: new Date('2025-01-01T00:00:00.000Z'),
      }],
      identities: [
        {
          id: 'identity-active', channel: 'telegram', externalId: 'opaque-a', phoneId: 'phone-1',
          displayName: 'Active', source: 'auto', confidence: 1, isActive: true,
          createdAt: new Date('2025-01-01T00:00:00.000Z'), reachabilityStatus: 'confirmed',
          reachabilityCheckedAt: null, metadata: { providerAccountId: 'bot-a', origin: 'provider' },
        },
        {
          id: 'identity-inactive', channel: 'telegram', externalId: 'opaque-b', phoneId: null,
          displayName: 'Inactive', source: 'auto', confidence: 1, isActive: false,
          createdAt: new Date('2025-02-01T00:00:00.000Z'), reachabilityStatus: 'unknown',
          reachabilityCheckedAt: null, metadata: {
            providerAccountId: 'bot-b', origin: 'provider', providerAliases: [{ aliasValue: 'alias-b' }],
          },
        },
      ],
      chats: [],
      mergesAsSurvivor: [],
      mergesAsMerged: [],
      driverProfiles: [driver('driver-a', 'park-a', 'profile-a')],
      mainDriver: null,
    })
  })

  test('keeps the compact active list while exposing every identity and lineage profile', async () => {
    const response = await GET(
      new NextRequest('https://crm.example/api/contacts/contact-1'),
      { params: Promise.resolve({ id: 'contact-1' }) },
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.identities.map((identity: { id: string }) => identity.id)).toEqual(['identity-active'])
    expect(body.channelIdentities.map((identity: { id: string }) => identity.id)).toEqual([
      'identity-active',
      'identity-inactive',
    ])
    expect(body.channelIdentities[1]).toMatchObject({
      externalId: 'opaque-b', providerAccountId: 'bot-b', aliases: [{ aliasValue: 'alias-b' }],
      conflicts: [{ conflictType: 'provider_account_identity_collision' }],
    })
    expect(body.driverProfiles.map((profile: { externalDriverProfileId: string }) => profile.externalDriverProfileId))
      .toEqual(['profile-a', 'profile-b'])
    expect(body.driverSummary).toMatchObject({ profileCount: 2, parkCount: 2 })
  })

  test('rejects unsigned and cross-origin updates before any Contact read or mutation', async () => {
    mocks.contactFindUnique.mockClear()
    mocks.principal.mockResolvedValueOnce(null)

    const unauthorized = await PATCH(patchRequest({ notes: 'forged' }), context)
    const crossOrigin = await PATCH(
      patchRequest({ notes: 'forged' }, 'https://attacker.example'),
      context,
    )

    expect(unauthorized.status).toBe(401)
    expect(crossOrigin.status).toBe(403)
    expect(mocks.principal).toHaveBeenCalledTimes(1)
    expect(mocks.contactFindUnique).not.toHaveBeenCalled()
    expect(mocks.contactUpdate).not.toHaveBeenCalled()
    expect(mocks.patchContact).not.toHaveBeenCalled()
  })

  test('rejects wholesale customFields replacement without reading or mutating the Contact', async () => {
    mocks.contactFindUnique.mockClear()

    const response = await PATCH(patchRequest({
      customFields: { driverConfirmations: [] },
      notes: 'must not partially apply',
    }), context)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'CUSTOM_FIELDS_REPLACEMENT_FORBIDDEN',
    })
    expect(mocks.contactFindUnique).not.toHaveBeenCalled()
    expect(mocks.contactUpdate).not.toHaveBeenCalled()
    expect(mocks.patchContact).not.toHaveBeenCalled()
  })

  test('preserves bounded authorized profile updates', async () => {
    mocks.contactFindUnique.mockResolvedValueOnce({ id: 'contact-1', isArchived: false })
    mocks.contactUpdate.mockResolvedValue({
      id: 'contact-1',
      displayName: 'Иванов Иван',
      displayNameSource: 'manual',
      masterSource: 'chat',
      primaryPhoneId: null,
      tags: [],
      notes: 'operator note',
      customFields: {},
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
    })

    const response = await PATCH(patchRequest({ notes: 'operator note' }), context)

    expect(response.status).toBe(200)
    expect(mocks.contactUpdate).toHaveBeenCalledWith({
      where: { id: 'contact-1' },
      data: {
        displayName: undefined,
        displayNameSource: undefined,
        tags: undefined,
        notes: 'operator note',
      },
    })
  })
})

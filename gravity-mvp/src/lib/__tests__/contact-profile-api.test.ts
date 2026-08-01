import { beforeEach, describe, expect, test, vi } from 'vitest'
import { CONTACT_PROFILE_SCHEMA_VERSION, deriveDriverProfileState } from '@/lib/contact-profile-contract'

const prismaMock = vi.hoisted(() => ({
  contact: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  driver: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
  parkConnection: {
    findMany: vi.fn(),
  },
  driverTelegram: {
    findMany: vi.fn(),
  },
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

const reachabilityMock = vi.hoisted(() => ({
  resolvePersonalMaxDurableRouteForIdentity: vi.fn(),
}))

vi.mock('@/lib/ReachabilityService', () => reachabilityMock)

import { GET } from '@/app/api/contacts/[id]/route'

const parks = ['Наш Автопарк', 'YOKO', 'YOKO-2', 'YOKO-3', 'YOKO-4', 'YOKO.Доставка']

function suggestedProfile(index: number) {
  const parkName = parks[index]
  const employmentTypes = ['park_employee', 'selfemployed', 'individual_entrepreneur']
  return {
    id: `driver-${index + 1}`,
    yandexDriverId: `legacy-${index + 1}`,
    externalDriverProfileId: `external-${index + 1}`,
    externalParkId: `park-external-${index + 1}`,
    fullName: index < 2 ? 'Ремезов Александр' : 'Ремезов Александр Юрьевич',
    phone: '+79222155750',
    lastExternalPark: parkName,
    parkId: `park-${index + 1}`,
    park: { parkCode: `PARK_${index + 1}`, parkName },
    sourceConnectionId: `connection-${index + 1}`,
    segment: 'self_employed',
    statusOverride: null,
    dismissedAt: null,
    contactId: null,
    externalPersonKey: null,
    personResolutionStatus: 'unlinked',
    personResolutionBasis: index < 2 ? null : 'source_only_backfill',
    lastFleetCheckStatus: 'working',
    lastFleetCheckAt: null,
    updatedAt: new Date('2026-07-13T12:00:00.000Z'),
    customFields: {
      yandexProfile: {
        employmentType: employmentTypes[index % employmentTypes.length],
        sourceWorkStatus: 'working',
        sourceCurrentStatus: 'offline',
        sourceUpdatedAt: '2026-07-13T12:00:00.000Z',
      },
    },
  }
}

describe('canonical Contact profile API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reachabilityMock.resolvePersonalMaxDurableRouteForIdentity.mockResolvedValue({ kind: 'active' })
    const contact = {
      id: 'contact-1',
      displayName: '+79222155750',
      displayNameSource: 'channel',
      masterSource: 'chat',
      yandexDriverId: null,
      mainDriverId: null,
      mainDriverSelection: 'auto',
      primaryPhoneId: 'phone-1',
      notes: null,
      tags: [],
      customFields: {},
      isArchived: false,
      createdAt: new Date('2026-07-13T12:00:00.000Z'),
      updatedAt: new Date('2026-07-13T12:00:00.000Z'),
      phones: [{
        id: 'phone-1',
        phone: '+79222155750',
        label: null,
        isPrimary: true,
        source: 'max',
        isActive: true,
        verifiedAt: null,
        isTemporary: false,
        expiresAt: null,
        createdAt: new Date('2026-07-13T12:00:00.000Z'),
      }],
      identities: [{
        id: 'identity-phone-placeholder',
        channel: 'max',
        externalId: '79222155750',
        phoneId: 'phone-1',
        displayName: null,
        source: 'auto',
        confidence: 1,
        isActive: true,
        createdAt: new Date('2026-07-13T12:00:00.000Z'),
        reachabilityStatus: 'confirmed',
        reachabilityCheckedAt: new Date('2026-07-13T12:00:00.000Z'),
        metadata: {},
      }, {
        id: 'identity-protocol-alias',
        channel: 'max',
        externalId: '902144614300',
        phoneId: null,
        displayName: null,
        source: 'auto',
        confidence: 1,
        isActive: true,
        createdAt: new Date('2026-07-13T12:00:00.000Z'),
        reachabilityStatus: 'confirmed',
        reachabilityCheckedAt: new Date('2026-07-13T12:00:00.000Z'),
        metadata: {},
      }, {
        id: 'identity-provider-route',
        channel: 'max',
        externalId: '901970535612',
        phoneId: null,
        displayName: null,
        source: 'auto',
        confidence: 1,
        isActive: true,
        createdAt: new Date('2026-07-13T12:00:00.000Z'),
        reachabilityStatus: 'unknown',
        reachabilityCheckedAt: null,
        metadata: {},
      }],
      chats: [{
        id: 'chat-1',
        channel: 'max',
        externalChatId: '902144614300',
        contactIdentityId: 'identity-provider-route',
        lastMessageAt: new Date('2026-07-13T12:00:00.000Z'),
        unreadCount: 0,
        status: 'new',
        name: 'MAX:902144614300',
        metadata: {},
      }, {
        id: 'chat-route-alias',
        channel: 'max',
        externalChatId: '2351835259',
        contactIdentityId: 'identity-provider-route',
        lastMessageAt: new Date('2026-07-13T11:59:00.000Z'),
        unreadCount: 0,
        status: 'new',
        name: 'MAX:2351835259',
        metadata: {
          personalMaxProjection: {
            state: 'superseded',
            evidencePreserved: true,
            canonicalChatId: 'chat-1',
          },
        },
      }],
      mergesAsSurvivor: [],
      mergesAsMerged: [],
    }
    prismaMock.contact.findUnique
      .mockResolvedValueOnce(contact)
      .mockResolvedValueOnce({ id: contact.id, phones: [{ phone: '+79222155750' }] })
    prismaMock.driver.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(parks.map((_, index) => suggestedProfile(index)))
    prismaMock.parkConnection.findMany.mockResolvedValue(parks.map((parkName, index) => ({
      parkId: `park-${index + 1}`,
      apiConnectionId: `connection-${index + 1}`,
      externalParkId: `park-external-${index + 1}`,
      lastSuccessfulSyncAt: null,
      lastFailedSyncAt: null,
      lastErrorSummary: null,
      park: { parkCode: `PARK_${index + 1}`, parkName },
    })))
    prismaMock.driverTelegram.findMany.mockResolvedValue([])
  })

  test('returns six phone-only suggestions without attaching or selecting a main profile', async () => {
    const response = await GET({} as never, { params: Promise.resolve({ id: 'contact-1' }) })
    expect(response.status).toBe(200)
    const body = await response.json()

    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0')
    expect(response.headers.get('X-CRM-Contact-Profile-Schema')).toBe(String(CONTACT_PROFILE_SCHEMA_VERSION))
    expect(body.schemaVersion).toBe(CONTACT_PROFILE_SCHEMA_VERSION)
    expect(body.driverProfileState).toBe('UNLINKED_WITH_SUGGESTIONS')
    expect(body.primaryPhone.phone).toBe('+79222155750')
    expect(body.channels.map((item: { channel: string }) => item.channel)).toEqual(['max', 'whatsapp', 'telegram'])
    expect(body.canonicalSummary.displayName).toBe('+7 922 215-57-50')
    expect(body.canonicalSummary.primaryPhone).toBe('+7 922 215-57-50')
    expect(body.canonicalSummary.channelCount).toBe(1)
    expect(body.chats.map((chat: { id: string }) => chat.id)).toEqual(['chat-1'])
    expect(body.channels.find((item: { channel: string }) => item.channel === 'max')).toMatchObject({
      identityId: 'identity-provider-route',
      externalId: '901970535612',
    })
    expect(body.identities.map((identity: { id: string }) => identity.id)).toEqual(['identity-provider-route'])
    expect(body.canonicalSummary.providerIdentities).toEqual([{
      channel: 'max',
      externalId: '901970535612',
      displayName: null,
    }])
    expect(body.suggestedProfiles).toHaveLength(6)
    expect(body.attachedProfiles).toEqual([])
    expect(body.mainDriverProfile).toBeNull()
    expect(body.driver).toBeNull()
    expect(body.technicalData.resolutionState).toBe('UNLINKED_WITH_SUGGESTIONS')
    expect(body.technicalData.schemaVersion).toBe(CONTACT_PROFILE_SCHEMA_VERSION)
    expect(body.technicalData.buildMarker).toBe('dev')
    expect(body.suggestedProfiles.every((profile: { matchedSignals: string[] }) => profile.matchedSignals.includes('phone'))).toBe(true)
    expect(body.suggestedProfiles.map((profile: { employmentTypeLabel: string }) => profile.employmentTypeLabel)).toEqual([
      'Физлицо',
      'Парковый СМЗ',
      'Парковый ИП',
      'Физлицо',
      'Парковый СМЗ',
      'Парковый ИП',
    ])
    expect(body.suggestedProfiles.every((profile: {
      employmentTypeCode: string
      normalizedStatus: string
      statusLabel: string
      suggestionBasis: string
      suggestionBasisLabel: string
      linkedContactConflict: boolean
    }) => profile.employmentTypeCode
      && profile.normalizedStatus === 'working'
      && profile.statusLabel === 'Работает'
      && profile.suggestionBasis === 'phone'
      && profile.suggestionBasisLabel === 'Совпадение номера телефона'
      && profile.linkedContactConflict === false)).toBe(true)
    expect(body.suggestedProfiles.every((profile: { workStatus: string }) => profile.workStatus === 'working')).toBe(true)
    expect(body.suggestedProfiles.every((profile: {
      dispatcher: { mode: string; url: string; parkRootUrl: string }
    }) => profile.dispatcher.mode === 'deep_link'
      && profile.dispatcher.url.startsWith('https://fleet.yandex.ru/map/drivers/')
      && profile.dispatcher.parkRootUrl.startsWith('https://fleet.yandex.ru/contractors?park_id='))).toBe(true)
    expect(body.technicalData.profileSourceValues).toHaveLength(6)
    expect(body.technicalData.profileSourceValues[0].employmentTypeCode).toBe('park_employee')
    expect(body.telegramBotState).toMatchObject({
      status: 'NO_TELEGRAM_IDENTITY',
      linked: false,
      driverProfile: null,
    })
    expect(prismaMock.driver.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.contact.update).not.toHaveBeenCalled()
  })
  test('serializes a 429 as a stale warning while keeping raw data technical', async () => {
    const rawError = 'NASH_AVTOPARK dismissed: Yandex API 429: {"code":"429","message":"Too many requests"}'
    const now = Date.now()
    prismaMock.parkConnection.findMany.mockResolvedValue([{
      parkId: 'park-1',
      apiConnectionId: 'connection-1',
      externalParkId: 'park-external-1',
      lastSuccessfulSyncAt: new Date(now - 60 * 60 * 1000),
      lastFailedSyncAt: new Date(now - 1000),
      lastErrorSummary: rawError,
      park: { parkCode: 'NASH_AVTOPARK', parkName: 'Наш Автопарк' },
    }])

    const response = await GET({} as never, { params: Promise.resolve({ id: 'contact-1' }) })
    const body = await response.json()

    expect(body.syncState.status).toBe('stale')
    expect(body.syncState.error).toBe('Не удалось обновить данные «Наш Автопарк». Показана последняя сохранённая информация.')
    expect(body.syncState.parks[0]).toMatchObject({
      state: 'backoff',
      canRetry: false,
      error: 'Не удалось обновить данные «Наш Автопарк». Показана последняя сохранённая информация.',
    })
    expect(String(body.syncState.error) + String(body.syncState.parks[0].error)).not.toContain('NASH_AVTOPARK')
    expect(JSON.stringify(body.anomalies)).not.toContain('Too many requests')
    expect(body.anomalies.some((item: { type: string }) => item.type === 'sync_error')).toBe(false)
    expect(body.technicalData.syncFailures[0].rawError).toBe(rawError)
  })


  test('derives stable profile states without using fake legacy defaults', () => {
    expect(deriveDriverProfileState(0, 0, 0)).toBe('UNLINKED')
    expect(deriveDriverProfileState(0, 6, 2)).toBe('UNLINKED_WITH_SUGGESTIONS')
    expect(deriveDriverProfileState(6, 0, 0)).toBe('LINKED')
    expect(deriveDriverProfileState(6, 0, 1)).toBe('LINKED_WITH_ANOMALIES')
  })
})

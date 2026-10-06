import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { prisma } from '@/lib/prisma'
import {
  normalizeDriverSearchQueryV1,
  searchLocalDriversV1,
  searchYandexParksByDriverQueryV1,
  upsertParkMatchedDriverV1,
} from '@/modules/fleet-operations/public/v1'
import { hasIntegrationAdminAccess } from '@/modules/identity-access/public/v1'
import { saveManualDriverTelegramLinkV1 } from '@/modules/telegram-channel/public/v1'

import { GET, POST } from './route'

vi.mock('@/lib/prisma', () => ({
  prisma: {
    driverTelegram: { findFirst: vi.fn() },
    driver: { findUnique: vi.fn() },
  },
}))
vi.mock('@/modules/fleet-operations/public/v1', () => ({
  canonicalDriverNameKeyV1: (value: unknown) => String(value ?? '')
    .toLocaleLowerCase('ru-RU')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join('\u0000'),
  normalizeDriverSearchQueryV1: vi.fn(),
  normalizeDriverPhoneDigitsV1: (value: unknown) => {
    const digits = String(value ?? '').replace(/\D/g, '')
    if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`
    if (digits.length === 10) return `7${digits}`
    return digits
  },
  searchLocalDriversV1: vi.fn(),
  searchYandexParksByDriverQueryV1: vi.fn(),
  upsertParkMatchedDriverV1: vi.fn(),
}))
vi.mock('@/modules/identity-access/public/v1', () => ({
  hasIntegrationAdminAccess: vi.fn(),
}))
vi.mock('@/modules/telegram-channel/public/v1', () => ({
  saveManualDriverTelegramLinkV1: vi.fn(),
}))

const searchLocal = vi.mocked(searchLocalDriversV1)
const searchYandex = vi.mocked(searchYandexParksByDriverQueryV1)
const normalizeSearch = vi.mocked(normalizeDriverSearchQueryV1)
const hasAdminAccess = vi.mocked(hasIntegrationAdminAccess)
const findLink = vi.mocked(prisma.driverTelegram.findFirst)
const findDriver = vi.mocked(prisma.driver.findUnique)
const upsertParkDriver = vi.mocked(upsertParkMatchedDriverV1)
const saveManualLink = vi.mocked(saveManualDriverTelegramLinkV1)

function mutationHeaders(contentType = 'application/json', origin = 'https://crm.example') {
  return { 'content-type': contentType, host: 'crm.example', origin }
}

function searchRequest(query: unknown) {
  return new NextRequest('https://crm.example/api/bot-link', {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify({ action: 'search', query }),
  })
}

function getRequest(telegramId = '42') {
  return new NextRequest(`https://crm.example/api/bot-link?telegramId=${telegramId}`)
}

function linkRequest(driverName: string) {
  return new NextRequest('https://crm.example/api/bot-link', {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify({
      action: 'link',
      telegramId: '42',
      driverId: 'yandex:park-1:driver-1',
      yandexDriverId: 'driver-1',
      parkId: 'park-1',
      driverName,
    }),
  })
}

function rawLinkRequest(payload: Record<string, unknown>) {
  return new NextRequest('https://crm.example/api/bot-link', {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify({ action: 'link', ...payload }),
  })
}

function rawBodyRequest(payload: unknown) {
  return new NextRequest('https://crm.example/api/bot-link', {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify(payload),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  hasAdminAccess.mockResolvedValue(true)
  normalizeSearch.mockImplementation(value => {
    const query = typeof value === 'string' ? value.trim() : ''
    return query.length >= 3 && query.length <= 120
      ? { status: 'ok' as const, query, phoneDigits: null, nameTokens: query.split(/\s+/) }
      : { status: 'invalid' as const }
  })
  searchLocal.mockImplementation(async query => (
    typeof query === 'string' && query.trim().length >= 3
      ? { status: 'ok' as const, query: query.trim(), drivers: [] }
      : { status: 'invalid' as const, drivers: [] }
  ))
  searchYandex.mockResolvedValue({ checkedParks: 9, results: [], errors: [] })
  saveManualLink.mockResolvedValue({
    contract: 'telegram_channel.SaveManualDriverTelegramLinkResult.v1',
    saved: true,
  })
})

describe('manual Telegram driver search', () => {
  it('rejects a cross-origin mutation before authorization or side effects', async () => {
    const response = await POST(new NextRequest('https://crm.example/api/bot-link', {
      method: 'POST',
      headers: mutationHeaders('application/json', 'https://evil.example'),
      body: JSON.stringify({ action: 'search', query: 'Иван Иванов' }),
    }))

    expect(response.status).toBe(403)
    expect(hasAdminAccess).not.toHaveBeenCalled()
    expect(searchLocal).not.toHaveBeenCalled()
    expect(searchYandex).not.toHaveBeenCalled()
  })

  it('rejects a non-JSON mutation before database or provider access', async () => {
    const response = await POST(new NextRequest('https://crm.example/api/bot-link', {
      method: 'POST',
      headers: mutationHeaders('text/plain'),
      body: JSON.stringify({ action: 'search', query: 'Иван Иванов' }),
    }))

    expect(response.status).toBe(415)
    expect(searchLocal).not.toHaveBeenCalled()
    expect(searchYandex).not.toHaveBeenCalled()
  })

  it.each([null, 'search', []])('rejects non-object JSON body %#', async payload => {
    const response = await POST(rawBodyRequest(payload))

    expect(response.status).toBe(400)
    expect(searchLocal).not.toHaveBeenCalled()
    expect(searchYandex).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated GET before reading linked-driver PII', async () => {
    hasAdminAccess.mockResolvedValue(false)

    const response = await GET(getRequest())

    expect(response.status).toBe(403)
    expect(findLink).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated search before database or provider access', async () => {
    hasAdminAccess.mockResolvedValue(false)

    const response = await POST(searchRequest('Терехин Владимир Евгеньевич'))

    expect(response.status).toBe(403)
    expect(searchLocal).not.toHaveBeenCalled()
    expect(searchYandex).not.toHaveBeenCalled()
  })

  it('does not call Yandex when the Fleet owner rejects a query', async () => {
    searchLocal.mockResolvedValue({ status: 'invalid', drivers: [] })
    const response = await POST(searchRequest('а о'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ drivers: [] })
    expect(searchLocal).toHaveBeenCalledWith('а о')
    expect(searchYandex).not.toHaveBeenCalled()
  })

  it('passes the Fleet-normalized query to the existing Yandex search', async () => {
    const response = await POST(searchRequest('Владимир Терехин Евгеньевич'))

    expect(response.status).toBe(200)
    expect(searchLocal).toHaveBeenCalledWith('Владимир Терехин Евгеньевич')
    expect(searchYandex).toHaveBeenCalledWith('Владимир Терехин Евгеньевич')
    await expect(response.json()).resolves.toEqual({ drivers: [], checkedParks: 9, errors: [] })
  })

  it('deduplicates reordered names with equivalent 8 and +7 phones', async () => {
    searchLocal.mockResolvedValue({
      status: 'ok',
      query: 'Иван Иванов',
      drivers: [{
        id: 'local-1',
        yandexDriverId: null,
        fullName: 'Иван Иванов',
        phone: '8 (999) 123-45-67',
      }],
    })
    searchYandex.mockResolvedValue({
      checkedParks: 9,
      errors: [],
      results: [{
        parkId: 'park-1',
        parkName: 'Парк 1',
        profiles: [{
          id: 'driver-1',
          fullName: 'Иванов Иван',
          phones: ['+7 999 123-45-67'],
          workStatus: 'working',
          currentStatus: 'free',
        }],
      }],
    })

    const response = await POST(searchRequest('Иван Иванов'))
    const body = await response.json()

    expect(body.drivers).toHaveLength(1)
    expect(body.drivers[0]).toMatchObject({ source: 'yandex', yandexDriverId: 'driver-1' })
  })

  it('deduplicates the same Yandex driver returned by multiple parks and retains one park identity', async () => {
    searchYandex.mockResolvedValue({
      checkedParks: 9,
      errors: [],
      results: [
        {
          parkId: 'park-1',
          parkName: 'Парк 1',
          profiles: [{
            id: 'driver-1',
            fullName: 'Иван Иванов',
            phones: [],
            workStatus: 'working',
            currentStatus: 'free',
          }],
        },
        {
          parkId: 'park-2',
          parkName: 'Парк 2',
          profiles: [{
            id: 'driver-1',
            fullName: 'Иван Иванов',
            phones: [],
            workStatus: 'working',
            currentStatus: 'free',
          }],
        },
      ],
    })

    const body = await (await POST(searchRequest('Иван Иванов'))).json()

    expect(body.drivers).toHaveLength(1)
    expect(body.drivers[0]).toMatchObject({ yandexDriverId: 'driver-1', parkId: 'park-1' })
  })

  it('deduplicates Yandex profiles with the same canonical name and equivalent non-empty phone', async () => {
    searchYandex.mockResolvedValue({
      checkedParks: 9,
      errors: [],
      results: [
        {
          parkId: 'park-1',
          parkName: 'Парк 1',
          profiles: [{
            id: 'driver-1',
            fullName: 'Иван Иванов',
            phones: ['8 (999) 123-45-67'],
            workStatus: 'working',
            currentStatus: 'free',
          }],
        },
        {
          parkId: 'park-2',
          parkName: 'Парк 2',
          profiles: [{
            id: 'driver-2',
            fullName: 'Иванов Иван',
            phones: ['+7 999 123-45-67'],
            workStatus: 'working',
            currentStatus: 'free',
          }],
        },
      ],
    })

    const body = await (await POST(searchRequest('Иван Иванов'))).json()

    expect(body.drivers).toHaveLength(1)
    expect(body.drivers[0]).toMatchObject({ yandexDriverId: 'driver-1', parkId: 'park-1' })
  })

  it.each([
    { secondPhones: [] },
    { secondPhones: ['+7 999 000-00-00'] },
  ])('keeps same-name Yandex profiles distinct when the second phone list is $secondPhones', async ({ secondPhones }) => {
    searchYandex.mockResolvedValue({
      checkedParks: 9,
      errors: [],
      results: [
        {
          parkId: 'park-1',
          parkName: 'Парк 1',
          profiles: [{
            id: 'driver-1',
            fullName: 'Иван Иванов',
            phones: ['+7 999 123-45-67'],
            workStatus: 'working',
            currentStatus: 'free',
          }],
        },
        {
          parkId: 'park-2',
          parkName: 'Парк 2',
          profiles: [{
            id: 'driver-2',
            fullName: 'Иванов Иван',
            phones: secondPhones,
            workStatus: 'working',
            currentStatus: 'free',
          }],
        },
      ],
    })

    const body = await (await POST(searchRequest('Иван Иванов'))).json()

    expect(body.drivers).toHaveLength(2)
    expect(body.drivers).toEqual(expect.arrayContaining([
      expect.objectContaining({ yandexDriverId: 'driver-1', parkId: 'park-1' }),
      expect.objectContaining({ yandexDriverId: 'driver-2', parkId: 'park-2' }),
    ]))
  })

  it.each([
    null,
    '+7 999 000-00-00',
  ])('keeps a distinct same-name local driver with nonmatching phone %s', async localPhone => {
    searchLocal.mockResolvedValue({
      status: 'ok',
      query: 'Иван Иванов',
      drivers: [{ id: 'local-1', yandexDriverId: null, fullName: 'Иван Иванов', phone: localPhone }],
    })
    searchYandex.mockResolvedValue({
      checkedParks: 9,
      errors: [],
      results: [{
        parkId: 'park-1',
        parkName: 'Парк 1',
        profiles: [{
          id: 'driver-1',
          fullName: 'Иванов Иван',
          phones: ['+7 999 123-45-67'],
          workStatus: 'working',
          currentStatus: 'free',
        }],
      }],
    })

    const response = await POST(searchRequest('Иван Иванов'))
    const body = await response.json()

    expect(body.drivers).toHaveLength(2)
    expect(body.drivers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'local-1', source: 'crm' }),
      expect.objectContaining({ yandexDriverId: 'driver-1', source: 'yandex' }),
    ]))
  })

  it('rejects an oversized Yandex link revalidation before provider access', async () => {
    const response = await POST(linkRequest('я'.repeat(121)))

    expect(response.status).toBe(400)
    expect(normalizeSearch).toHaveBeenCalled()
    expect(searchYandex).not.toHaveBeenCalled()
  })

  it.each([
    { telegramId: { invalid: true }, driverId: 'local-1' },
    { telegramId: '9'.repeat(21), driverId: 'local-1' },
    { telegramId: '9223372036854775808', driverId: 'local-1' },
    { telegramId: '42', driverId: 'x'.repeat(201) },
    { telegramId: '42', driverId: 'local-1', username: 'a'.repeat(33) },
  ])('rejects invalid or oversized link identity %#', async payload => {
    const response = await POST(rawLinkRequest(payload))

    expect(response.status).toBe(400)
    expect(findDriver).not.toHaveBeenCalled()
    expect(searchYandex).not.toHaveBeenCalled()
  })

  it('links a local Driver only through the authority-enforcing owner command', async () => {
    findDriver.mockResolvedValue({ id: 'local-1', fullName: 'Иван Иванов' } as never)

    const response = await POST(rawLinkRequest({ telegramId: '42', driverId: 'local-1' }))

    expect(response.status).toBe(200)
    expect(saveManualLink).toHaveBeenCalledWith({
      contract: 'telegram_channel.SaveManualDriverTelegramLinkCommand.v1',
      driverId: 'local-1',
      telegramId: 42n,
    })
    await expect(response.json()).resolves.toEqual({ success: true, driverName: 'Иван Иванов' })
  })

  it('returns a conflict with no fallback mutation when owner authority is absent', async () => {
    findDriver.mockResolvedValue({ id: 'local-1', fullName: 'Иван Иванов' } as never)
    saveManualLink.mockRejectedValue(
      new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED'),
    )

    const response = await POST(rawLinkRequest({ telegramId: '42', driverId: 'local-1' }))

    expect(response.status).toBe(409)
    expect(saveManualLink).toHaveBeenCalledOnce()
    expect(upsertParkDriver).not.toHaveBeenCalled()
  })

  it('does not create a local Driver for a provider-only search candidate', async () => {
    searchYandex.mockResolvedValue({
      checkedParks: 9,
      errors: [],
      results: [{
        parkId: 'park-1',
        parkName: 'Парк 1',
        profiles: [{
          id: 'driver-1',
          fullName: 'Иван Иванов',
          phones: ['+79990000000'],
          workStatus: 'working',
          currentStatus: 'free',
        }],
      }],
    })
    findDriver.mockResolvedValue(null)

    const response = await POST(linkRequest('Иван Иванов'))

    expect(response.status).toBe(409)
    expect(upsertParkDriver).not.toHaveBeenCalled()
    expect(saveManualLink).not.toHaveBeenCalled()
  })

  it('links a provider-verified profile only when Fleet supplies the same existing local Driver', async () => {
    searchYandex.mockResolvedValue({
      checkedParks: 9,
      errors: [],
      results: [{
        parkId: 'park-1',
        parkName: 'Парк 1',
        profiles: [{
          id: 'yandex-driver-1',
          driverId: 'local-1',
          fullName: 'Иван Иванов',
          phones: ['+79990000000'],
          workStatus: 'working',
          currentStatus: 'free',
        }],
      }],
    })
    findDriver.mockResolvedValue({
      id: 'local-1',
      fullName: 'Иван Иванов',
      yandexDriverId: 'yandex-driver-1',
    } as never)

    const response = await POST(rawLinkRequest({
      telegramId: '42',
      driverId: 'local-1',
      yandexDriverId: 'yandex-driver-1',
      parkId: 'park-1',
      driverName: 'Иван Иванов',
    }))

    expect(response.status).toBe(200)
    expect(upsertParkDriver).not.toHaveBeenCalled()
    expect(saveManualLink).toHaveBeenCalledWith({
      contract: 'telegram_channel.SaveManualDriverTelegramLinkCommand.v1',
      driverId: 'local-1',
      telegramId: 42n,
    })
  })
})

describe('Driver profile identity and person-confirmation state for a manual Telegram link', () => {
  const verifiedProfile = {
    id: 'yandex-driver-2',
    driverId: 'local-2',
    fullName: 'Анна Петрова',
    phones: ['+79990000002'],
    workStatus: 'working',
    currentStatus: 'free',
  }
  const linkSelected = () => rawLinkRequest({
    telegramId: '42',
    driverId: 'local-2',
    yandexDriverId: 'yandex-driver-2',
    parkId: 'park-1',
    driverName: 'Анна Петрова',
  })

  beforeEach(() => {
    searchYandex.mockResolvedValue({
      checkedParks: 6,
      errors: [],
      results: [{ parkId: 'park-1', parkName: 'Парк 1', profiles: [verifiedProfile] }],
    })
  })

  it('links a Fleet-created Driver through its park-qualified external profile pair', async () => {
    findDriver.mockResolvedValue({
      id: 'local-2',
      fullName: 'Анна Петрова',
      yandexDriverId: 'park-profile:0123456789abcdef0123456789abcdef',
      externalDriverProfileId: 'yandex-driver-2',
      externalParkId: 'park-1',
    } as never)
    const response = await POST(linkSelected())
    expect(response.status).toBe(200)
    expect(saveManualLink).toHaveBeenCalledWith({
      contract: 'telegram_channel.SaveManualDriverTelegramLinkCommand.v1',
      driverId: 'local-2',
      telegramId: 42n,
    })
  })

  it('still links a legacy Driver that carries the raw provider id', async () => {
    findDriver.mockResolvedValue({
      id: 'local-2',
      fullName: 'Анна Петрова',
      yandexDriverId: 'yandex-driver-2',
      externalDriverProfileId: null,
      externalParkId: null,
    } as never)
    const response = await POST(linkSelected())
    expect(response.status).toBe(200)
    expect(saveManualLink).toHaveBeenCalledOnce()
  })

  it.each([
    ['a different external profile id', { externalDriverProfileId: 'yandex-driver-9', externalParkId: 'park-1' }],
    ['the same profile id in another park', { externalDriverProfileId: 'yandex-driver-2', externalParkId: 'park-2' }],
    ['no external pair at all', { externalDriverProfileId: null, externalParkId: null }],
  ])('fails closed on %s without calling the link owner', async (_label, pair) => {
    findDriver.mockResolvedValue({
      id: 'local-2',
      fullName: 'Анна Петрова',
      yandexDriverId: 'park-profile:0123456789abcdef0123456789abcdef',
      ...pair,
    } as never)
    const response = await POST(linkSelected())
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.code).toBe('DRIVER_PROFILE_UNVERIFIED')
    // A pure identity mismatch must not be presented as a person decision.
    expect(JSON.stringify(body)).not.toContain('Confirm the driver person')
    expect(body.code).not.toBe('PERSON_CONFIRMATION_REQUIRED')
    expect(saveManualLink).not.toHaveBeenCalled()
  })

  it('keeps the real person-confirmation gate once identity is proven, as a structured state', async () => {
    findDriver.mockResolvedValue({
      id: 'local-2',
      fullName: 'Анна Петрова',
      yandexDriverId: 'park-profile:0123456789abcdef0123456789abcdef',
      externalDriverProfileId: 'yandex-driver-2',
      externalParkId: 'park-1',
    } as never)
    saveManualLink.mockRejectedValue(new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED'))
    const response = await POST(linkSelected())
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.code).toBe('PERSON_CONFIRMATION_REQUIRED')
    expect(body.error).toMatch(/подтвердите/)
    expect(saveManualLink).toHaveBeenCalledOnce()
    expect(upsertParkDriver).not.toHaveBeenCalled()
  })

  it.each([
    [new Error('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED'), 'TELEGRAM_CHAT_REQUIRED'],
    [new Error('DRIVER_TELEGRAM_IDENTITY_BINDING_MISMATCH'), 'TELEGRAM_IDENTITY_UNVERIFIED'],
    [Object.assign(new Error('The Driver or Telegram peer already has a different link'), { code: 'DRIVER_TELEGRAM_LINK_CONTRADICTION' }), 'TELEGRAM_LINK_CONFLICT'],
    [Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }), 'TELEGRAM_LINK_REJECTED'],
    [new Error('constructor'), 'TELEGRAM_LINK_REJECTED'],
  ])('maps an owner refusal to an operator code (%s)', async (refusal, code) => {
    findDriver.mockResolvedValue({ id: 'local-1', fullName: 'Иван Иванов' } as never)
    saveManualLink.mockRejectedValue(refusal)
    const response = await POST(rawLinkRequest({ telegramId: '42', driverId: 'local-1' }))
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.code).toBe(code)
    expect(typeof body.error).toBe('string')
    expect(body).not.toHaveProperty('success')
  })

  it('exposes the Fleet person state the operator needs to confirm the Driver', async () => {
    searchYandex.mockResolvedValue({
      checkedParks: 6,
      errors: [],
      results: [{
        parkId: 'park-1',
        parkName: 'Парк 1',
        profiles: [
          { ...verifiedProfile, profileClusterKey: 'vu:7700123456', contactId: null, clusterWarnings: [], contactMergeCandidateIds: [] },
          { ...verifiedProfile, id: 'yandex-driver-3', driverId: 'local-3', fullName: 'Олег Смирнов', phones: ['+79990000003'], profileClusterKey: 'vu:7700999999', contactId: 'contact-p', clusterWarnings: ['incomplete_cluster_evidence'], contactMergeCandidateIds: [] },
        ],
      }],
    })
    searchLocal.mockResolvedValue({
      status: 'ok' as const,
      query: 'Петров',
      drivers: [{ id: 'crm-9', yandexDriverId: null, fullName: 'Пётр Петров', phone: null }],
    } as never)
    const response = await POST(searchRequest('Петров'))
    const { drivers } = await response.json()
    expect(drivers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'local-2', profileClusterKey: 'vu:7700123456', personContactId: null, personReviewRequired: false }),
      expect.objectContaining({ id: 'local-3', profileClusterKey: 'vu:7700999999', personContactId: 'contact-p', personReviewRequired: true }),
      expect.objectContaining({ id: 'crm-9', source: 'crm', profileClusterKey: null, personContactId: null, personReviewRequired: false }),
    ]))
  })
})

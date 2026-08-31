import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { prisma } from '@/lib/prisma'
import {
  normalizeDriverSearchQueryV1,
  searchLocalDriversV1,
  searchYandexParksByDriverQueryV1,
} from '@/modules/fleet-operations/public/v1'
import { hasIntegrationAdminAccess } from '@/modules/identity-access/public/v1'

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
  replaceDriverTelegramLinkV1: vi.fn(),
  upsertDriverTelegramLinkV1: vi.fn(),
}))

const searchLocal = vi.mocked(searchLocalDriversV1)
const searchYandex = vi.mocked(searchYandexParksByDriverQueryV1)
const normalizeSearch = vi.mocked(normalizeDriverSearchQueryV1)
const hasAdminAccess = vi.mocked(hasIntegrationAdminAccess)
const findLink = vi.mocked(prisma.driverTelegram.findFirst)
const findDriver = vi.mocked(prisma.driver.findUnique)

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
})

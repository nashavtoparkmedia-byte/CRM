import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  contact: { findMany: vi.fn() },
  contactIdentity: { findMany: vi.fn() },
  chat: { findMany: vi.fn() },
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { GET } from '@/app/api/contacts/search/route'

const hydratedContact = {
  id: 'contact-shaburov',
  displayName: '902158371854',
  masterSource: 'chat',
  yandexDriverId: null,
  primaryPhoneId: 'phone-1',
  mainDriverId: 'driver-1',
  phones: [{ id: 'phone-1', phone: '+79126646745', isPrimary: true, source: 'manual' }],
  identities: [{
    id: 'identity-max',
    channel: 'max',
    externalId: '902158371854',
    displayName: null,
    metadata: {},
    reachabilityStatus: 'confirmed',
  }],
  chats: [{ id: 'chat-max', channel: 'max', lastMessageAt: new Date('2026-07-16T06:00:00Z') }],
  driverProfiles: [{
    id: 'driver-1',
    fullName: 'Шабуров Евгений Анатольевич',
    phone: '+79126646745',
    segment: 'medium',
    dismissedAt: null,
    lastExternalPark: 'Наш Автопарк',
  }],
}


const weakProviderOnlyContact = {
  id: 'contact-provider-only-shaburov',
  displayName: 'Шабуров Евгений UBER',
  masterSource: 'chat',
  yandexDriverId: null,
  primaryPhoneId: null,
  mainDriverId: null,
  phones: [],
  identities: [{
    id: 'identity-whatsapp',
    channel: 'whatsapp',
    externalId: '261297237192949@lid',
    displayName: 'Шабуров Евгений UBER',
    metadata: {},
    reachabilityStatus: 'unknown',
  }],
  chats: [{ id: 'chat-wa', channel: 'whatsapp', lastMessageAt: new Date('2026-06-11T20:22:42Z') }],
  driverProfiles: [],
}

function request(query: string) {
  return new NextRequest(`http://localhost/api/contacts/search?q=${encodeURIComponent(query)}&limit=8`)
}

describe('Contact search API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.$queryRaw.mockResolvedValue([{ contactId: hydratedContact.id }])
    prismaMock.contactIdentity.findMany.mockResolvedValue([])
    prismaMock.chat.findMany.mockResolvedValue([])
  })

  test('finds a canonical DriverProfile name by partial tokens and returns the existing Contact once', async () => {
    prismaMock.contact.findMany
      .mockResolvedValueOnce([hydratedContact])

    const response = await GET(request('евг анат'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.total).toBe(1)
    expect(body.contacts[0].id).toBe(hydratedContact.id)
    expect(body.contacts[0].displayName).toBe('Шабуров Евгений Анатольевич')
    expect(body.contacts[0].canonicalSummary.primaryPhone).toBe('+7 912 664-67-45')
    expect(body.contacts[0].hasChat).toEqual({ max: 'chat-max' })

    const sql = prismaMock.$queryRaw.mock.calls[0][0] as { values: unknown[] }
    expect(sql.values).toContain('%евг%')
    expect(sql.values).toContain('%анат%')
    // Production PostgreSQL runs with locale=C, so lower()/ILIKE do not fold Cyrillic.
    // Keep title-case variants to find DriverProfile names such as "Шабуров Евгений".
    expect(sql.values).toContain('%Евг%')
    expect(sql.values).toContain('%Анат%')
  })


  test('prefers the canonical CRM Contact over a provider-only duplicate for surname search', async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([
      { contactId: weakProviderOnlyContact.id },
      { contactId: hydratedContact.id },
    ])
    prismaMock.contact.findMany.mockResolvedValueOnce([weakProviderOnlyContact, hydratedContact])

    const response = await GET(request('шабу'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.total).toBe(1)
    expect(body.contacts).toHaveLength(1)
    expect(body.contacts[0].id).toBe(hydratedContact.id)
    expect(body.contacts[0].displayName).toBe('Шабуров Евгений Анатольевич')
    expect(body.contacts[0].canonicalSummary.primaryPhone).toBe('+7 912 664-67-45')
  })

  test.each([
    ['79126646745', '79126646745'],
    ['89126646745', '79126646745'],
    ['+7 912 664-67-45', '79126646745'],
    ['9126646745', '79126646745'],
    ['6646745', '6646745'],
  ])('normalizes phone query %s before database matching', async (query, expectedDigits) => {
    prismaMock.contact.findMany.mockResolvedValueOnce([hydratedContact])

    const response = await GET(request(query))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.contacts).toHaveLength(1)
    const sql = prismaMock.$queryRaw.mock.calls[0][0] as { values: unknown[] }
    expect(sql.values).toContain(`%${expectedDigits}%`)
  })

  test('protects against a too-short numeric query', async () => {
    const response = await GET(request('6745'))
    const body = await response.json()

    expect(body).toEqual({ contacts: [], total: 0 })
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled()
    expect(prismaMock.contactIdentity.findMany).not.toHaveBeenCalled()
    expect(prismaMock.contact.findMany).not.toHaveBeenCalled()
  })
})

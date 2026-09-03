import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  contactPhoneFindMany: vi.fn(),
  contactIdentityFindMany: vi.fn(),
  contactFindMany: vi.fn(),
  chatFindMany: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    contactPhone: { findMany: mocks.contactPhoneFindMany },
    contactIdentity: { findMany: mocks.contactIdentityFindMany },
    contact: { findMany: mocks.contactFindMany },
    chat: { findMany: mocks.chatFindMany },
  },
}))

import { GET } from './route'

describe('Contact search conversation ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.contactIdentityFindMany.mockResolvedValue([])
  })

  test('never assigns a Driver chat to Contacts that merely share its phone', async () => {
    mocks.contactPhoneFindMany.mockResolvedValue([
      { contact: { id: 'contact-a' } },
      { contact: { id: 'contact-b' } },
    ])
    mocks.contactFindMany.mockResolvedValue([
      {
        id: 'contact-a',
        displayName: 'Person A',
        masterSource: 'manual',
        yandexDriverId: null,
        phones: [{ id: 'phone-a', phone: '+79990000000', isPrimary: true, source: 'manual' }],
        identities: [],
        chats: [],
      },
      {
        id: 'contact-b',
        displayName: 'Person B',
        masterSource: 'manual',
        yandexDriverId: null,
        phones: [{ id: 'phone-b', phone: '+79990000000', isPrimary: true, source: 'manual' }],
        identities: [{ id: 'identity-b', channel: 'telegram', externalId: '42', reachabilityStatus: 'confirmed' }],
        chats: [{ id: 'chat-b', channel: 'telegram', lastMessageAt: new Date('2026-09-02T12:00:00Z') }],
      },
    ])

    const response = await GET(new NextRequest(
      'https://crm.example/api/contacts/search?q=%2B79990000000',
    ))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      contacts: [
        { id: 'contact-a', hasChat: {}, channels: [] },
        { id: 'contact-b', hasChat: { telegram: 'chat-b' }, channels: ['telegram'] },
      ],
      total: 2,
    })
    expect(mocks.chatFindMany).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, test, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
  contactIdentity: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  whatsAppConnection: { findMany: vi.fn() },
  telegramConnection: { findMany: vi.fn() },
  maxPersonalSession: { findMany: vi.fn() },
  maxConnection: { findMany: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import {
  findIdentityByPhoneAndChannel,
  getProviderConnectionHealth,
  resolveReachabilityIdentity,
} from '@/lib/ReachabilityService'

describe('strict reachability identity resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('accepts an explicitly requested identity only when channel and Contact phone match', async () => {
    prismaMock.contactIdentity.findUnique.mockResolvedValue({
      id: 'identity-1',
      channel: 'telegram',
      externalId: '100500',
      isActive: true,
      reachabilityStatus: 'confirmed',
      reachabilityCheckedAt: new Date('2026-07-18T10:00:00.000Z'),
      phone: null,
      contact: {
        isArchived: false,
        phones: [{ phone: '+79222155750' }],
      },
    })
    await expect(resolveReachabilityIdentity(
      '8 (922) 215-57-50',
      'telegram',
      'identity-1',
    )).resolves.toMatchObject({
      kind: 'matched',
      identity: { id: 'identity-1', reachabilityStatus: 'confirmed' },
    })
  })

  test('rejects a requested identity belonging to another phone', async () => {
    prismaMock.contactIdentity.findUnique.mockResolvedValue({
      id: 'identity-other',
      channel: 'max',
      externalId: 'provider-user-id',
      isActive: true,
      reachabilityStatus: 'unknown',
      reachabilityCheckedAt: null,
      phone: null,
      contact: {
        isArchived: false,
        phones: [{ phone: '+79120000000' }],
      },
    })
    await expect(resolveReachabilityIdentity(
      '+79222155750',
      'max',
      'identity-other',
    )).resolves.toEqual({ kind: 'invalid_requested_identity' })
  })

  test('returns ambiguous for two phone-linked identities and never picks the first', async () => {
    prismaMock.contactIdentity.findMany.mockResolvedValue([
      { id: 'identity-b', reachabilityStatus: 'unknown', reachabilityCheckedAt: null },
      { id: 'identity-a', reachabilityStatus: 'confirmed', reachabilityCheckedAt: new Date() },
    ])
    await expect(resolveReachabilityIdentity('+79222155750', 'whatsapp')).resolves.toEqual({
      kind: 'ambiguous',
      identityIds: ['identity-a', 'identity-b'],
    })
    await expect(findIdentityByPhoneAndChannel('+79222155750', 'whatsapp')).resolves.toBeNull()
    expect(prismaMock.contactIdentity.findMany).toHaveBeenCalledTimes(2)
  })
})

describe('provider connection health is separate from account reachability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('maps WhatsApp ready and disconnected sessions without a provider request', async () => {
    prismaMock.whatsAppConnection.findMany.mockResolvedValue([{ status: 'ready' }])
    await expect(getProviderConnectionHealth('whatsapp')).resolves.toBe('connected')
    prismaMock.whatsAppConnection.findMany.mockResolvedValue([{ status: 'authenticated' }])
    await expect(getProviderConnectionHealth('whatsapp')).resolves.toBe('disconnected')
    prismaMock.whatsAppConnection.findMany.mockResolvedValue([{ status: 'disconnected' }])
    await expect(getProviderConnectionHealth('whatsapp')).resolves.toBe('disconnected')
  })

  test('maps active Telegram and MAX CRM connections', async () => {
    prismaMock.telegramConnection.findMany.mockResolvedValue([{ isActive: true }])
    await expect(getProviderConnectionHealth('telegram')).resolves.toBe('connected')

    prismaMock.maxPersonalSession.findMany.mockResolvedValue([{
      isActive: true,
      connectedAt: new Date('2026-07-18T10:00:00.000Z'),
    }])
    prismaMock.maxConnection.findMany.mockResolvedValue([])
    await expect(getProviderConnectionHealth('max')).resolves.toBe('connected')
  })
})

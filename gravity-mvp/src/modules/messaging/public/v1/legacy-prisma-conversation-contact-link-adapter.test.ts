import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  transaction: {
    $queryRaw: vi.fn(),
    contactIdentity: { findUnique: vi.fn() },
    contact: { findUnique: vi.fn() },
    chat: { findUnique: vi.fn(), update: vi.fn() },
    driver: { findUnique: vi.fn() },
  },
  transactionRunner: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: mocks.transactionRunner,
  },
}))

import { legacyPrismaConversationContactLinkPortV1 } from './legacy-prisma-conversation-contact-link-adapter'

describe('admitted conversation Contact link', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transactionRunner.mockImplementation(async (operation: (transaction: unknown) => unknown) => (
      operation(mocks.transaction)
    ))
    mocks.transaction.$queryRaw.mockResolvedValue([{ admitted: true }])
    mocks.transaction.contactIdentity.findUnique.mockResolvedValue({
      id: 'identity-1', contactId: 'survivor', isActive: true,
    })
    mocks.transaction.contact.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (
      where.id === 'survivor'
        ? { id: 'survivor', isArchived: false, yandexDriverId: null }
        : { isArchived: true, customFields: { mergedIntoContactId: 'survivor' } }
    ))
    mocks.transaction.chat.findUnique.mockResolvedValue({ driverId: null })
    mocks.transaction.chat.update.mockResolvedValue({ id: 'chat-1' })
  })

  test('a merge between resolution and attachment revalidates to the current survivor', async () => {
    await legacyPrismaConversationContactLinkPortV1.ensure({
      chatId: 'chat-1', contactId: 'loser', contactIdentityId: 'identity-1',
    })

    expect(mocks.transaction.$queryRaw).toHaveBeenCalledTimes(1)
    expect(mocks.transaction.contactIdentity.findUnique).toHaveBeenCalledTimes(1)
    expect(mocks.transaction.chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      data: { contactId: 'survivor', contactIdentityId: 'identity-1' },
    })
    expect(mocks.transaction.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transaction.contactIdentity.findUnique.mock.invocationCallOrder[0],
    )
  })

  test('an unrelated stale Contact cannot be paired with the identity', async () => {
    mocks.transaction.contact.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (
      where.id === 'survivor'
        ? { id: 'survivor', isArchived: false, yandexDriverId: null }
        : { isArchived: false, customFields: {} }
    ))
    await expect(legacyPrismaConversationContactLinkPortV1.ensure({
      chatId: 'chat-1', contactId: 'other', contactIdentityId: 'identity-1',
    })).rejects.toThrow('CONTACT_IDENTITY_LINK_MISMATCH')
    expect(mocks.transaction.chat.update).not.toHaveBeenCalled()
  })
})

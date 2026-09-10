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
        ? {
            id: 'survivor',
            isArchived: false,
            mainDriverId: null,
            customFields: {},
          }
        : { isArchived: true, customFields: { mergedIntoContactId: 'survivor' } }
    ))
    mocks.transaction.chat.findUnique.mockResolvedValue({
      contactId: null,
      contactIdentityId: null,
      driverId: null,
    })
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
        ? {
            id: 'survivor',
            isArchived: false,
            mainDriverId: null,
            customFields: {},
          }
        : { isArchived: false, customFields: {} }
    ))
    await expect(legacyPrismaConversationContactLinkPortV1.ensure({
      chatId: 'chat-1', contactId: 'other', contactIdentityId: 'identity-1',
    })).rejects.toThrow('CONTACT_IDENTITY_LINK_MISMATCH')
    expect(mocks.transaction.chat.update).not.toHaveBeenCalled()
  })

  test('rejects an existing Driver that differs from the canonical confirmed main Driver', async () => {
    mocks.transaction.contact.findUnique.mockResolvedValue({
      id: 'survivor',
      isArchived: false,
      mainDriverId: 'canonical-driver',
      customFields: {
        driverConfirmations: [{
          status: 'confirmed',
          representativeDriverId: 'canonical-driver',
        }],
      },
    })
    mocks.transaction.chat.findUnique.mockResolvedValue({
      contactId: 'survivor',
      contactIdentityId: 'identity-1',
      driverId: 'different-driver',
    })

    await expect(legacyPrismaConversationContactLinkPortV1.ensure({
      chatId: 'chat-1', contactId: 'survivor', contactIdentityId: 'identity-1',
    })).rejects.toThrow('CONTACT_CONVERSATION_DRIVER_MISMATCH')

    expect(mocks.transaction.chat.update).not.toHaveBeenCalled()
  })

  test('rejects an existing Driver when the canonical Contact has no matching confirmation', async () => {
    mocks.transaction.contact.findUnique.mockResolvedValue({
      id: 'survivor',
      isArchived: false,
      mainDriverId: 'driver-1',
      customFields: {
        driverConfirmations: [{
          status: 'needs_reconciliation',
          representativeDriverId: 'driver-1',
        }],
      },
    })
    mocks.transaction.chat.findUnique.mockResolvedValue({
      contactId: 'survivor',
      contactIdentityId: 'identity-1',
      driverId: 'driver-1',
    })

    await expect(legacyPrismaConversationContactLinkPortV1.ensure({
      chatId: 'chat-1', contactId: 'survivor', contactIdentityId: 'identity-1',
    })).rejects.toThrow('CONTACT_CONVERSATION_DRIVER_MISMATCH')

    expect(mocks.transaction.chat.update).not.toHaveBeenCalled()
  })

  test('populates Driver only from the canonical confirmed main Driver', async () => {
    mocks.transaction.contact.findUnique.mockResolvedValue({
      id: 'survivor',
      isArchived: false,
      mainDriverId: 'canonical-driver',
      customFields: {
        driverConfirmations: [{
          status: 'confirmed',
          representativeDriverId: 'canonical-driver',
        }],
      },
    })

    await legacyPrismaConversationContactLinkPortV1.ensure({
      chatId: 'chat-1', contactId: 'survivor', contactIdentityId: 'identity-1',
    })

    expect(mocks.transaction.driver.findUnique).not.toHaveBeenCalled()
    expect(mocks.transaction.chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      data: {
        contactId: 'survivor',
        contactIdentityId: 'identity-1',
        driverId: 'canonical-driver',
      },
    })
  })

  test('does not populate Driver from a legacy Yandex link alone', async () => {
    mocks.transaction.contact.findUnique.mockResolvedValue({
      id: 'survivor',
      isArchived: false,
      yandexDriverId: 'legacy-yandex-driver',
      mainDriverId: null,
      customFields: {},
    })

    await legacyPrismaConversationContactLinkPortV1.ensure({
      chatId: 'chat-1', contactId: 'survivor', contactIdentityId: 'identity-1',
    })

    expect(mocks.transaction.driver.findUnique).not.toHaveBeenCalled()
    expect(mocks.transaction.chat.update).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      data: { contactId: 'survivor', contactIdentityId: 'identity-1' },
    })
  })

  test.each([
    {
      existing: { contactId: 'other-contact', contactIdentityId: null, driverId: null },
      label: 'Contact',
    },
    {
      existing: { contactId: 'survivor', contactIdentityId: 'other-identity', driverId: null },
      label: 'ContactIdentity',
    },
    {
      existing: {
        contactId: 'other-contact',
        contactIdentityId: 'other-identity',
        driverId: null,
      },
      label: 'Contact and ContactIdentity',
    },
  ])('does not overwrite an existing non-null $label binding', async ({ existing }) => {
    mocks.transaction.chat.findUnique.mockResolvedValue(existing)

    await expect(legacyPrismaConversationContactLinkPortV1.ensure({
      chatId: 'chat-1', contactId: 'survivor', contactIdentityId: 'identity-1',
    })).rejects.toThrow('CONTACT_CONVERSATION_OWNERSHIP_MISMATCH')

    expect(mocks.transaction.driver.findUnique).not.toHaveBeenCalled()
    expect(mocks.transaction.chat.update).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  identityFindMany: vi.fn(),
  addPhone: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    contactIdentity: { findMany: mocks.identityFindMany },
  },
}))
vi.mock('@/modules/contacts/public/v1', () => ({
  addPhoneToContactV1: mocks.addPhone,
  isResolvedChannelContactResultV1: vi.fn(),
  markTemporaryContactPhoneV1: vi.fn(),
  resolveChannelContactOperationV1: vi.fn(),
}))
vi.mock('@/modules/messaging/public/v1', () => ({
  ensureLeadConversationV1: vi.fn(),
  receiveMessageV1: vi.fn(),
}))

import { updateLeadPhone } from './intake'

const input = {
  source: 'avito' as const,
  sourceExternalId: 'lead-42',
  providerAccountId: 'avito-account-7',
  contactId: 'contact-a',
  phone: '+7 999 000-00-01',
}

describe('lead phone exact identity ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.identityFindMany.mockResolvedValue([{
      contactId: 'contact-a',
      metadata: { providerAccountId: 'avito-account-7' },
    }])
    mocks.addPhone.mockResolvedValue({
      kind: 'added',
      phoneId: 'phone-a',
      contactId: 'contact-a',
    })
  })

  test('revalidates the exact active source identity before mutating phone evidence', async () => {
    await expect(updateLeadPhone(input)).resolves.toEqual({ phoneId: 'phone-a', merged: false })
    expect(mocks.identityFindMany).toHaveBeenCalledWith({
      where: { channel: 'avito', externalId: 'lead-42', isActive: true },
      select: { contactId: true, metadata: true },
      take: 2,
    })
    expect(mocks.addPhone).toHaveBeenCalledWith('contact-a', '+79990000001', expect.any(Object))
  })

  test('rejects a stale or corrupt Contact backlink with zero phone mutation', async () => {
    await expect(updateLeadPhone({ ...input, contactId: 'contact-b' }))
      .rejects.toThrow('source Contact backlink does not own the exact identity')
    expect(mocks.addPhone).not.toHaveBeenCalled()
  })

  test('rejects another provider account and malformed account scope with zero mutation', async () => {
    await expect(updateLeadPhone({ ...input, providerAccountId: 'avito-account-8' }))
      .rejects.toThrow('no unique exact identity')
    await expect(updateLeadPhone({ ...input, providerAccountId: ' avito-account-7 ' }))
      .rejects.toThrow('concrete providerAccountId is required')
    expect(mocks.addPhone).not.toHaveBeenCalled()
  })
})

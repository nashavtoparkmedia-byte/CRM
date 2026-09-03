import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runOwnership: vi.fn(),
  lockRows: vi.fn(),
  assertPostconditions: vi.fn(),
  identityFind: vi.fn(),
  identityUpdate: vi.fn(),
  contactFind: vi.fn(),
  contactUpdate: vi.fn(),
}))

vi.mock('../../internal/contact-ownership-coordinator', () => ({
  runContactOwnershipTransaction: mocks.runOwnership,
  lockContactOwnershipRows: mocks.lockRows,
  assertContactOwnershipPostconditions: mocks.assertPostconditions,
}))

import { markChannelIdentityConflictV1 } from './channel-identity-conflict'

const input = {
  contactId: 'contact-1',
  identityId: 'identity-1',
  channel: 'telegram' as const,
  reason: 'provider_account_mismatch',
  evidenceRoot: 'channel-collision:telegram:telegram:42:telegram-bot-b',
  details: {
    incomingProviderAccountId: 'telegram-bot-b',
    existingProviderAccountId: 'telegram-bot-a',
  },
}

describe('Contacts-owned channel identity conflict', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const transaction = {
      contactIdentity: {
        findUnique: mocks.identityFind,
        update: mocks.identityUpdate,
      },
      contact: {
        findUnique: mocks.contactFind,
        update: mocks.contactUpdate,
      },
    }
    mocks.runOwnership.mockImplementation(async (work: (value: unknown) => Promise<unknown>) => work(transaction))
    mocks.lockRows.mockResolvedValue({
      contactIds: ['contact-1'],
      phoneIds: [],
      normalizedPhones: [],
      identityIds: ['identity-1'],
      mergeIds: [],
    })
    mocks.identityFind.mockResolvedValue({
      id: 'identity-1',
      contactId: 'contact-1',
      channel: 'telegram',
      externalId: '42',
      isActive: true,
      metadata: { providerAccountId: 'telegram-bot-a', conflictState: 'clear' },
    })
    mocks.contactFind.mockResolvedValue({
      id: 'contact-1',
      isArchived: false,
      customFields: { keep: true },
    })
  })

  test('records an open Contact conflict and marks the exact identity conflicted', async () => {
    await markChannelIdentityConflictV1(input)

    expect(mocks.lockRows).toHaveBeenCalledWith(expect.anything(), {
      contactIds: ['contact-1'],
      identityIds: ['identity-1'],
    })
    expect(mocks.contactUpdate).toHaveBeenCalledWith({
      where: { id: 'contact-1' },
      data: {
        customFields: expect.objectContaining({
          keep: true,
          identityConflicts: [expect.objectContaining({
            identityId: 'identity-1',
            conflictType: 'channel_identity_collision',
            evidenceRoot: input.evidenceRoot,
            source: 'channel-ingress',
            status: 'open',
            details: expect.objectContaining({
              channel: 'telegram',
              reason: 'provider_account_mismatch',
              externalUserId: '42',
            }),
          })],
        }),
      },
    })
    expect(mocks.identityUpdate).toHaveBeenCalledWith({
      where: { id: 'identity-1' },
      data: {
        metadata: {
          providerAccountId: 'telegram-bot-a',
          conflictState: 'conflicted',
        },
      },
    })
    expect(mocks.assertPostconditions).toHaveBeenCalledOnce()
  })

  test('rejects a stale Contact/Identity pair without mutation', async () => {
    mocks.identityFind.mockResolvedValue({
      id: 'identity-1',
      contactId: 'contact-other',
      channel: 'telegram',
      externalId: '42',
      isActive: true,
      metadata: {},
    })

    await expect(markChannelIdentityConflictV1(input))
      .rejects.toThrow('CHANNEL_IDENTITY_CONFLICT_TARGET_MISMATCH')
    expect(mocks.contactUpdate).not.toHaveBeenCalled()
    expect(mocks.identityUpdate).not.toHaveBeenCalled()
  })
})

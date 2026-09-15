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
  reason: 'peer_identity_mismatch',
  evidenceRoot: 'channel-collision:telegram:telegram:42:telegram-bot-b:conn-b:42:peer_identity_mismatch',
  details: {
    incomingPeerId: '42',
    existingPeerId: '99',
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

  test('records an open Contact conflict without permanently disabling the identity', async () => {
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
              reason: 'peer_identity_mismatch',
              externalUserId: '42',
            }),
          })],
        }),
      },
    })
    // The append-only audit above is the whole record. conflictState is read as
    // a hard deny by reachability, contact conversation preparation and the
    // driver-link authority, so one ingress observation must never be able to
    // permanently disable an identity.
    expect(mocks.identityUpdate).not.toHaveBeenCalled()
    expect(mocks.assertPostconditions).toHaveBeenCalledOnce()
  })

  test.each([
    ['telegram', 'transport_connection_mismatch'],
    ['telegram', 'transport_connection_unproven'],
    ['telegram', 'provider_account_mismatch'],
    ['telegram', 'provider_account_unproven'],
    ['whatsapp', 'transport_mismatch'],
    ['whatsapp', 'transport_unbound'],
    ['max', 'provider_account_mismatch'],
    ['max', 'provider_account_unproven'],
  ] as const)('refuses to record a %s %s transport collision as a person conflict', async (channel, reason) => {
    await expect(markChannelIdentityConflictV1({ ...input, channel, reason }))
      .rejects.toThrow('transport collision is not a person identity conflict')

    expect(mocks.runOwnership).not.toHaveBeenCalled()
    expect(mocks.contactUpdate).not.toHaveBeenCalled()
    expect(mocks.identityUpdate).not.toHaveBeenCalled()
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

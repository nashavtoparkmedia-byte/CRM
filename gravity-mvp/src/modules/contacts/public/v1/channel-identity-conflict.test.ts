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

  const maxRouteRegimeSenderMismatch = {
    incomingProviderAccountId: 'max-account-b',
    existingProviderAccountId: 'max-account-b',
    incomingSenderId: 'max-sender-42',
    existingSenderId: 'max-sender-99',
    incomingChatKind: 'private',
    existingChatKind: 'private',
  }

  test.each([
    ['absent sender proof', 'sender_identity_unproven', { ...maxRouteRegimeSenderMismatch, existingSenderId: null }],
    ['absent sender proof on a stamped private conversation', 'sender_identity_unproven', maxRouteRegimeSenderMismatch],
    ['a legacy unstamped last-writer sender', 'sender_identity_mismatch', {
      ...maxRouteRegimeSenderMismatch, existingProviderAccountId: null, existingChatKind: 'unknown',
    }],
    ['a legacy label-stamped sender without a chat kind', 'sender_identity_mismatch', {
      ...maxRouteRegimeSenderMismatch, existingProviderAccountId: 'canary-operator-label', existingChatKind: 'unknown',
    }],
    ['no recorded details', 'sender_identity_mismatch', {}],
    ['another account\'s stamped private sender', 'sender_identity_mismatch', {
      ...maxRouteRegimeSenderMismatch, existingProviderAccountId: 'max-account-a',
    }],
    ['placeholder accounts', 'sender_identity_mismatch', {
      ...maxRouteRegimeSenderMismatch, existingProviderAccountId: 'legacy', incomingProviderAccountId: 'legacy',
    }],
    ['the company account as the stored sender', 'sender_identity_mismatch', {
      ...maxRouteRegimeSenderMismatch, existingSenderId: 'max-account-b',
    }],
    ['group traffic into a never-proven private kind', 'chat_kind_mismatch', {
      ...maxRouteRegimeSenderMismatch, existingChatKind: 'unknown', incomingChatKind: 'group',
    }],
    ['a global message key collision', 'message_chat_mismatch', maxRouteRegimeSenderMismatch],
    ['a cross-channel conversation key collision', 'channel_mismatch', maxRouteRegimeSenderMismatch],
  ] as const)('refuses to record a MAX conflict built on %s', async (_label, reason, details) => {
    await expect(markChannelIdentityConflictV1({ ...input, channel: 'max', reason, details }))
      .rejects.toThrow('collision evidence does not prove a person identity conflict')

    expect(mocks.runOwnership).not.toHaveBeenCalled()
    expect(mocks.contactUpdate).not.toHaveBeenCalled()
    expect(mocks.identityUpdate).not.toHaveBeenCalled()
  })

  test('still records group traffic into a proven private MAX conversation', async () => {
    mocks.identityFind.mockResolvedValue({
      id: 'identity-1',
      contactId: 'contact-1',
      channel: 'max',
      externalId: 'max-sender-42',
      isActive: true,
      metadata: {},
    })

    await markChannelIdentityConflictV1({
      ...input,
      channel: 'max',
      reason: 'chat_kind_mismatch',
      evidenceRoot: 'channel-collision:max:max-conversation-900:max-account-b:chat_kind_mismatch',
      details: { ...maxRouteRegimeSenderMismatch, existingSenderId: 'max-sender-42', incomingChatKind: 'group' },
    })

    expect(mocks.contactUpdate).toHaveBeenCalledOnce()
  })

  test('still records a MAX sender contradiction of proven private peer evidence', async () => {
    mocks.identityFind.mockResolvedValue({
      id: 'identity-1',
      contactId: 'contact-1',
      channel: 'max',
      externalId: 'max-sender-99',
      isActive: true,
      metadata: {},
    })

    await markChannelIdentityConflictV1({
      ...input,
      channel: 'max',
      reason: 'sender_identity_mismatch',
      evidenceRoot: 'channel-collision:max:max-conversation-900:max-account-b:sender_identity_mismatch',
      details: maxRouteRegimeSenderMismatch,
    })

    expect(mocks.contactUpdate).toHaveBeenCalledOnce()
    expect(mocks.contactUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        customFields: expect.objectContaining({
          identityConflicts: [expect.objectContaining({
            status: 'open',
            details: expect.objectContaining({ channel: 'max', reason: 'sender_identity_mismatch' }),
          })],
        }),
      },
    }))
  })

  test('a duplicate proven MAX contradiction does not append a second person conflict', async () => {
    const evidenceRoot = 'channel-collision:max:max-conversation-900:max-account-b:sender_identity_mismatch'
    mocks.identityFind.mockResolvedValue({
      id: 'identity-1',
      contactId: 'contact-1',
      channel: 'max',
      externalId: 'max-sender-99',
      isActive: true,
      metadata: {},
    })
    mocks.contactFind.mockResolvedValue({
      id: 'contact-1',
      isArchived: false,
      customFields: {
        identityConflicts: [{
          identityId: 'identity-1',
          conflictType: 'channel_identity_collision',
          evidenceRoot,
          source: 'channel-ingress',
          details: { channel: 'max', reason: 'sender_identity_mismatch', externalUserId: 'max-sender-99' },
          status: 'open',
        }],
      },
    })

    await markChannelIdentityConflictV1({
      ...input,
      channel: 'max',
      reason: 'sender_identity_mismatch',
      evidenceRoot,
      details: maxRouteRegimeSenderMismatch,
    })

    expect(mocks.contactUpdate).not.toHaveBeenCalled()
    expect(mocks.identityUpdate).not.toHaveBeenCalled()
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

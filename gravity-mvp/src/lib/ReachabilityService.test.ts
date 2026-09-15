import { beforeEach, describe, expect, test, vi } from 'vitest'

type IdentityRow = {
  id: string
  contactId: string
  channel: 'telegram' | 'whatsapp' | 'max'
  externalId: string
  phoneId: string | null
  isActive: boolean
  metadata: Record<string, unknown>
  reachabilityStatus: 'confirmed' | 'unreachable' | 'unknown'
  reachabilityCheckedAt: Date | null
  createdAt: Date
  contact: {
    id: string
    displayName: string
    isArchived: boolean
    customFields: Record<string, unknown>
  }
}

const mocks = vi.hoisted(() => ({
  runOwnership: vi.fn(),
  lockOwnershipRows: vi.fn(),
  identityFindUnique: vi.fn(),
  identityFindFirst: vi.fn(),
  identityUpdate: vi.fn(),
  contactFindUnique: vi.fn(),
  chatFindUnique: vi.fn(),
  prismaIdentityUpdate: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chat: { findUnique: mocks.chatFindUnique },
    contactIdentity: { update: mocks.prismaIdentityUpdate },
  },
}))
vi.mock('@/modules/contacts/internal/contact-ownership-coordinator', () => ({
  lockContactOwnershipRows: mocks.lockOwnershipRows,
  runContactOwnershipTransaction: mocks.runOwnership,
}))
vi.mock('@/lib/ContactService', () => ({ ContactService: {} }))
vi.mock('@/lib/contacts/SafeContactResolutionExecutor', () => ({
  isSafeContactResolutionSuccess: vi.fn(),
}))

import { recordExactProviderReachability } from './ReachabilityService'
import { legacyPrismaContactConversationPortV1 } from '@/modules/contacts/public/v1/legacy-prisma-contact-conversation-adapter'

const identities = new Map<string, IdentityRow>()

function identity(
  id: string,
  contactId: string,
  externalId: string,
  providerAccountId: string,
): IdentityRow {
  return {
    id,
    contactId,
    channel: 'telegram',
    externalId,
    phoneId: 'shared-phone-id',
    isActive: true,
    metadata: { providerAccountId, origin: 'provider' },
    reachabilityStatus: 'unknown',
    reachabilityCheckedAt: null,
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    contact: {
      id: contactId,
      displayName: `Contact ${contactId}`,
      isArchived: false,
      customFields: {},
    },
  }
}

function exactCommand(overrides: Record<string, unknown> = {}) {
  return {
    identityId: 'identity-a',
    contactId: 'contact-a',
    channel: 'telegram' as const,
    providerAccountId: 'telegram-account-a',
    providerTargetId: 'opaque-user-a',
    status: 'confirmed' as const,
    ...overrides,
  }
}

describe('exact ContactIdentity reachability persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    identities.clear()
    identities.set('identity-a', identity(
      'identity-a',
      'contact-a',
      'opaque-user-a',
      'telegram-account-a',
    ))
    identities.set('identity-b', identity(
      'identity-b',
      'contact-b',
      'opaque-user-b',
      'telegram-account-b',
    ))

    const transaction = {
      contact: {
        findUnique: mocks.contactFindUnique,
      },
      contactIdentity: {
        findUnique: mocks.identityFindUnique,
        findFirst: mocks.identityFindFirst,
        update: mocks.identityUpdate,
      },
    }
    mocks.runOwnership.mockImplementation(async (
      work: (tx: typeof transaction) => Promise<unknown>,
    ) => work(transaction))
    mocks.identityFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (
      identities.get(where.id) ?? null
    ))
    mocks.identityFindFirst.mockImplementation(async ({ where }: {
      where: { id: string; contactId: string; channel: IdentityRow['channel'] }
    }) => {
      const row = identities.get(where.id)
      if (
        !row
        || row.contactId !== where.contactId
        || row.channel !== where.channel
        || !row.isActive
      ) return null
      return row
    })
    mocks.identityUpdate.mockImplementation(async ({
      where,
      data,
    }: {
      where: { id: string }
      data: { reachabilityStatus: IdentityRow['reachabilityStatus']; reachabilityCheckedAt: Date }
    }) => {
      const row = identities.get(where.id)
      if (!row) throw new Error('missing identity')
      row.reachabilityStatus = data.reachabilityStatus
      row.reachabilityCheckedAt = data.reachabilityCheckedAt
      return row
    })
    mocks.contactFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      const row = [...identities.values()].find(candidate => candidate.contactId === where.id)
      return row?.contact ?? null
    })
  })

  test('updates only the exact identity when two Contacts claim the same phone', async () => {
    const result = await recordExactProviderReachability(exactCommand())

    expect(result).toEqual({
      outcome: 'updated',
      identityId: 'identity-a',
      status: 'confirmed',
    })
    expect(identities.get('identity-a')?.reachabilityStatus).toBe('confirmed')
    expect(identities.get('identity-b')?.reachabilityStatus).toBe('unknown')
    expect(mocks.identityFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'identity-a' },
    }))
    expect(mocks.lockOwnershipRows).toHaveBeenCalledWith(expect.anything(), {
      contactIds: ['contact-a'],
      identityIds: ['identity-a'],
    })
    expect(mocks.identityUpdate).toHaveBeenCalledWith({
      where: { id: 'identity-a' },
      data: {
        reachabilityStatus: 'confirmed',
        reachabilityCheckedAt: expect.any(Date),
      },
    })
  })

  test.each([
    ['another Contact owner', { contactId: 'contact-b' }, 'contact_owner_mismatch'],
    ['another provider target', { providerTargetId: 'opaque-user-b' }, 'provider_target_mismatch'],
    ['another channel', { channel: 'max' }, 'channel_mismatch'],
  ])('rejects %s without changing either same-phone identity', async (_label, overrides, reason) => {
    await expect(recordExactProviderReachability(exactCommand(overrides))).resolves.toEqual({
      outcome: 'rejected',
      reason,
    })

    expect(mocks.identityUpdate).not.toHaveBeenCalled()
    expect(identities.get('identity-a')?.reachabilityStatus).toBe('unknown')
    expect(identities.get('identity-b')?.reachabilityStatus).toBe('unknown')
  })

  test('accepts an exact account-scoped provider alias without accepting arbitrary targets', async () => {
    const row = identities.get('identity-a')!
    row.channel = 'whatsapp'
    row.externalId = 'opaque-peer@lid'
    row.metadata = {
      providerAccountId: 'whatsapp-account-a',
      providerAliasValues: ['79990001122@c.us'],
    }

    await expect(recordExactProviderReachability(exactCommand({
      channel: 'whatsapp',
      providerAccountId: 'whatsapp-account-a',
      providerTargetId: '79990001122@c.us',
    }))).resolves.toMatchObject({ outcome: 'updated', identityId: 'identity-a' })
    await expect(recordExactProviderReachability(exactCommand({
      channel: 'whatsapp',
      providerAccountId: 'whatsapp-account-a',
      providerTargetId: '79990009999@c.us',
    }))).resolves.toEqual({ outcome: 'rejected', reason: 'provider_target_mismatch' })
  })

  test('does not authorize legacy, inactive, archived, or conflicted identity evidence', async () => {
    const row = identities.get('identity-a')!

    row.metadata = { providerAccountId: 'telegram-account-a' }
    row.isActive = false
    await expect(recordExactProviderReachability(exactCommand())).resolves.toEqual({
      outcome: 'rejected', reason: 'identity_inactive',
    })

    row.isActive = true
    row.contact.isArchived = true
    await expect(recordExactProviderReachability(exactCommand())).resolves.toEqual({
      outcome: 'rejected', reason: 'contact_archived',
    })

    row.contact.isArchived = false
    row.contact.customFields = {
      identityConflicts: [{ identityId: 'identity-a', status: 'open' }],
    }
    await expect(recordExactProviderReachability(exactCommand())).resolves.toEqual({
      outcome: 'rejected', reason: 'identity_conflicted',
    })
    expect(mocks.identityUpdate).not.toHaveBeenCalled()
  })

  test('preserves stronger direct proof against one exact negative pre-check', async () => {
    identities.get('identity-a')!.reachabilityStatus = 'confirmed'

    await expect(recordExactProviderReachability(exactCommand({ status: 'unreachable' }))).resolves.toEqual({
      outcome: 'confirmed_preserved',
      identityId: 'identity-a',
      status: 'confirmed',
    })
    expect(mocks.identityUpdate).not.toHaveBeenCalled()
  })

  test('an accepted exact private inbound proof makes only that identity outbound-ready', async () => {
    await expect(recordExactProviderReachability(exactCommand())).resolves.toMatchObject({
      outcome: 'updated',
    })

    const prepared = await legacyPrismaContactConversationPortV1.prepareContactConversationIdentity({
      contactId: 'contact-a',
      channel: 'telegram', purpose: 'open_conversation',
      identityId: 'identity-a',
      phoneId: null,
    })
    expect(prepared).toMatchObject({
      status: 'ready',
      contact: { id: 'contact-a' },
      identity: {
        id: 'identity-a',
        externalId: 'opaque-user-a',
        providerAccountId: 'telegram-account-a',
      },
    })
    expect(identities.get('identity-b')?.reachabilityStatus).toBe('unknown')
  })

  describe('transport collisions versus genuine person conflicts', () => {
    function ingressCollision(
      row: IdentityRow,
      reason: string,
      details: Record<string, unknown>,
    ) {
      return {
        otherContactIds: [],
        identityId: row.id,
        conflictType: 'channel_identity_collision',
        evidenceRoot: `channel-collision:${row.channel}:key:${reason}`,
        source: 'channel-ingress',
        details: { ...details, channel: row.channel, reason, externalUserId: row.externalId },
        detectedAt: '2026-09-10T00:00:00.000Z',
        status: 'open',
      }
    }

    function botApiTransportMismatch(row: IdentityRow) {
      return ingressCollision(row, 'transport_connection_mismatch', {
        incomingProviderAccountId: 'telegram-bot-b',
        existingProviderAccountId: null,
        incomingConnectionId: 'driver-bot-primary',
        existingConnectionId: '7001',
        incomingChatKind: 'private',
        existingChatKind: 'private',
      })
    }

    async function prepareOpen(identityId: string, channel: IdentityRow['channel'] = 'telegram') {
      return legacyPrismaContactConversationPortV1.prepareContactConversationIdentity({
        contactId: 'contact-a',
        channel,
        purpose: 'open_conversation',
        identityId,
        phoneId: null,
      })
    }

    test('a transport failure on one route does not stop legitimate reachability through another account', async () => {
      const row = identities.get('identity-a')!
      row.contact.customFields = { identityConflicts: [botApiTransportMismatch(row)] }

      // The proof arrives through telegram-account-a; the recorded collision was
      // between the Bot API connection and an MTProto connection.
      await expect(recordExactProviderReachability(exactCommand())).resolves.toMatchObject({
        outcome: 'updated',
        identityId: 'identity-a',
        status: 'confirmed',
      })
      await expect(prepareOpen('identity-a')).resolves.toMatchObject({ status: 'ready' })
    })

    // Person level only. The collided WhatsApp conversation itself is quarantined
    // for outbound by Messaging (outbound-conversation-identity-runtime.test.ts);
    // here neither of the Contact's identities may be disabled by that fact.
    test('a WhatsApp transport mismatch disables neither that identity nor the same Contact\'s Telegram identity', async () => {
      const telegramRow = identities.get('identity-a')!
      telegramRow.reachabilityStatus = 'confirmed'
      const whatsappRow: IdentityRow = {
        ...identity('identity-wa', 'contact-a', '79990001122@c.us', 'wa-slot-a'),
        channel: 'whatsapp',
        reachabilityStatus: 'confirmed',
        contact: telegramRow.contact,
      }
      identities.set('identity-wa', whatsappRow)
      telegramRow.contact.customFields = {
        identityConflicts: [ingressCollision(whatsappRow, 'transport_mismatch', {
          phase: 'live',
          externalChatId: 'whatsapp:79990001122',
          incomingConnectionId: 'wa-slot-b',
          existingConnectionId: 'wa-slot-a',
        })],
      }

      await expect(prepareOpen('identity-wa', 'whatsapp')).resolves.toMatchObject({ status: 'ready' })
      await expect(prepareOpen('identity-a')).resolves.toMatchObject({ status: 'ready' })
    })

    test('a genuine identity conflict still denies reachability and outbound preparation', async () => {
      const row = identities.get('identity-a')!
      row.reachabilityStatus = 'confirmed'
      row.contact.customFields = {
        identityConflicts: [
          botApiTransportMismatch(row),
          ingressCollision(row, 'peer_identity_mismatch', { incomingPeerId: 'opaque-user-a', existingPeerId: 'other-peer' }),
        ],
      }

      await expect(recordExactProviderReachability(exactCommand())).resolves.toEqual({
        outcome: 'rejected', reason: 'identity_conflicted',
      })
      await expect(prepareOpen('identity-a')).resolves.toEqual({ status: 'identity_conflicted' })
      expect(mocks.identityUpdate).not.toHaveBeenCalled()
    })

    test('an existing historical conflict without provable transport provenance stays fail-closed', async () => {
      const row = identities.get('identity-a')!
      row.reachabilityStatus = 'confirmed'
      // MTProto-shaped: the transport arm could have hidden a chat-kind
      // contradiction that was never recorded, so it cannot be classified.
      row.contact.customFields = {
        identityConflicts: [ingressCollision(row, 'transport_connection_mismatch', {
          phase: 'inbound',
          incomingPeerId: 'opaque-user-a',
          existingPeerId: 'opaque-user-a',
          incomingConnectionId: '7002',
          existingConnectionId: '7001',
        })],
      }

      await expect(recordExactProviderReachability(exactCommand())).resolves.toEqual({
        outcome: 'rejected', reason: 'identity_conflicted',
      })
      await expect(prepareOpen('identity-a')).resolves.toEqual({ status: 'identity_conflicted' })
    })

    test('the identity conflictState flag keeps blocking whatever the conflict list says', async () => {
      const row = identities.get('identity-a')!
      row.reachabilityStatus = 'confirmed'
      row.metadata = { ...row.metadata, conflictState: 'conflicted' }
      row.contact.customFields = { identityConflicts: [botApiTransportMismatch(row)] }

      await expect(recordExactProviderReachability(exactCommand())).resolves.toEqual({
        outcome: 'rejected', reason: 'identity_conflicted',
      })
      await expect(prepareOpen('identity-a')).resolves.toEqual({ status: 'identity_conflicted' })
    })
  })

  test('rejects malformed or legacy-sentinel authority before opening CNT1', async () => {
    await expect(recordExactProviderReachability(exactCommand({ providerTargetId: ' target ' }))).resolves.toEqual({
      outcome: 'rejected', reason: 'invalid_binding',
    })
    expect(mocks.runOwnership).not.toHaveBeenCalled()
  })
})

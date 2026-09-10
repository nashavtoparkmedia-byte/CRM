import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  chatUpdate: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}))

import { appendConversationIdentityCollisionV1 } from './conversation-identity-collision'

describe('atomic conversation identity collision audit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(async (work: (transaction: unknown) => Promise<unknown>) => work({
      $queryRaw: mocks.queryRaw,
      chat: { update: mocks.chatUpdate },
    }))
    mocks.chatUpdate.mockResolvedValue({ id: 'chat-1' })
  })

  test('locks the Chat row and atomically appends a bounded de-duplicated entry', async () => {
    const evidence = {
      channel: 'max' as const,
      reason: 'provider_account_mismatch',
      incomingProviderAccountId: 'account-b',
      existingProviderAccountId: 'account-a',
    }
    mocks.queryRaw.mockResolvedValue([{
      id: 'chat-1',
      metadata: {
        keep: true,
        channelIdentityCollisionAudit: [
          ...Array.from({ length: 24 }, (_, index) => ({
            channel: 'max',
            reason: `older-${index}`,
            observedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
          })),
          { ...evidence, observedAt: '2026-01-30T00:00:00.000Z' },
        ],
      },
    }])

    await appendConversationIdentityCollisionV1({ chatId: 'chat-1', evidence })

    expect(mocks.queryRaw).toHaveBeenCalledOnce()
    expect(mocks.chatUpdate).toHaveBeenCalledOnce()
    const metadata = mocks.chatUpdate.mock.calls[0][0].data.metadata
    expect(metadata.keep).toBe(true)
    expect(metadata.channelIdentityCollisionAudit).toHaveLength(20)
    expect(metadata.channelIdentityCollisionAudit.filter(
      (entry: Record<string, unknown>) => entry.reason === evidence.reason,
    )).toHaveLength(1)
    expect(metadata.channelIdentityCollisionAudit.at(-1)).toEqual({
      ...evidence,
      observedAt: expect.any(String),
    })
  })

  test('fails without writing when the locked Chat no longer exists', async () => {
    mocks.queryRaw.mockResolvedValue([])

    await expect(appendConversationIdentityCollisionV1({
      chatId: 'chat-missing',
      evidence: { channel: 'telegram', reason: 'provider_account_mismatch' },
    })).rejects.toThrow('CONVERSATION_IDENTITY_COLLISION_CHAT_NOT_FOUND')
    expect(mocks.chatUpdate).not.toHaveBeenCalled()
  })

  test('retains only the newly observed collision when the limit is one', async () => {
    mocks.queryRaw.mockResolvedValue([{
      id: 'chat-1',
      metadata: {
        channelIdentityCollisionAudit: [
          { channel: 'max', reason: 'older' },
          { channel: 'telegram', reason: 'older-too' },
        ],
      },
    }])

    await appendConversationIdentityCollisionV1({
      chatId: 'chat-1',
      evidence: { channel: 'max', reason: 'new' },
      limit: 1,
    })

    const audit = mocks.chatUpdate.mock.calls[0][0].data.metadata.channelIdentityCollisionAudit
    expect(audit).toEqual([{
      channel: 'max',
      reason: 'new',
      observedAt: expect.any(String),
    }])
  })
})

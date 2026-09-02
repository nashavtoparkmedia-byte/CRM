import { describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ chatRead: vi.fn(), messageRead: vi.fn(), chatCreate: vi.fn() }))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    chat: { findUnique: mocks.chatRead, upsert: mocks.chatCreate },
    message: { findFirst: mocks.messageRead },
  },
}))

import { GET } from './route'

describe('retired forwarded MAX sender resolver', () => {
  test('cannot guess or create a conversation from a caller-supplied sender', async () => {
    const response = await GET()
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      chatId: null,
      error: 'CONTACT_CONVERSATION_IDENTITY_REQUIRED',
    })
    expect(mocks.chatRead).not.toHaveBeenCalled()
    expect(mocks.messageRead).not.toHaveBeenCalled()
    expect(mocks.chatCreate).not.toHaveBeenCalled()
  })
})

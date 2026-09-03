import { describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ chatRead: vi.fn(), chatPatch: vi.fn(), contactPatch: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ prisma: { chat: { findUnique: mocks.chatRead } } }))
vi.mock('@/modules/messaging/public/v1', () => ({ patchExternalConversationV1: mocks.chatPatch }))
vi.mock('@/modules/contacts/public/v1', () => ({ resolveContactV1: mocks.contactPatch }))

import { POST } from './route'

describe('retired MAX name sync', () => {
    test('cannot rename any Chat or Contact', async () => {
        const response = await POST()
        expect(response.status).toBe(409)
        await expect(response.json()).resolves.toEqual({ error: 'MAX_NAME_SYNC_RETIRED' })
        expect(mocks.chatRead).not.toHaveBeenCalled()
        expect(mocks.chatPatch).not.toHaveBeenCalled()
        expect(mocks.contactPatch).not.toHaveBeenCalled()
    })
})

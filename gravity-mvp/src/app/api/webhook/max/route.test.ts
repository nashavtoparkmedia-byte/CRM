import { NextRequest } from 'next/server'
import { describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    prismaRead: vi.fn(),
    prismaWrite: vi.fn(),
    contactMutation: vi.fn(),
    messagingMutation: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: new Proxy({}, { get: () => ({
        findFirst: mocks.prismaRead,
        findUnique: mocks.prismaRead,
        create: mocks.prismaWrite,
        update: mocks.prismaWrite,
        upsert: mocks.prismaWrite,
    }) }),
}))
vi.mock('@/modules/contacts/public/v1', () => ({
    resolveChannelContactOperationV1: mocks.contactMutation,
    markChannelIdentityConflictV1: mocks.contactMutation,
}))
vi.mock('@/modules/messaging/public/v1', () => ({
    createExternalConversationV1: mocks.messagingMutation,
    ensureConversationContactLinkV1: mocks.messagingMutation,
    upsertExternalMessageV1: mocks.messagingMutation,
}))

import { POST } from './route'

describe('retired singular MAX webhook', () => {
    test('returns a static tombstone before parsing or any persistence mutation', async () => {
        const request = new NextRequest('https://crm.example/api/webhook/max', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{malformed',
        })
        const jsonSpy = vi.spyOn(request, 'json')

        const response = await POST()

        expect(response.status).toBe(410)
        await expect(response.json()).resolves.toEqual({
            error: 'MAX_LEGACY_WEBHOOK_RETIRED',
            replacement: '/api/webhooks/max',
        })
        expect(jsonSpy).not.toHaveBeenCalled()
        expect(mocks.prismaRead).not.toHaveBeenCalled()
        expect(mocks.prismaWrite).not.toHaveBeenCalled()
        expect(mocks.contactMutation).not.toHaveBeenCalled()
        expect(mocks.messagingMutation).not.toHaveBeenCalled()
    })
})

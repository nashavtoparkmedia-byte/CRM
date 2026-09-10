import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ open: vi.fn(), principal: vi.fn() }))

vi.mock('@/modules/platform-shell/internal/contact-conversation-orchestrator', () => ({
    openContactConversationForContactV1: mocks.open,
}))
vi.mock('@/modules/identity-access/public/v1', async importOriginal => ({
    ...await importOriginal<typeof import('@/modules/identity-access/public/v1')>(),
    getIntegrationAdminPrincipal: mocks.principal,
}))

import { POST } from './route'

const context = { params: Promise.resolve({ id: 'contact-1' }) }

function request(body: Record<string, unknown> = {}, origin = 'https://crm.example') {
    return new NextRequest('https://crm.example/api/contacts/contact-1/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'crm.example', origin },
        body: JSON.stringify({ channel: 'telegram', identityId: 'identity-1', ...body }),
    })
}

describe('Contact outbound chat boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.principal.mockResolvedValue({
            id: 'identity-access:integration-admin-session',
            kind: 'integration_admin_session',
        })
    })

    test('rejects an unsigned selector and a cross-origin request with zero orchestration', async () => {
        mocks.principal.mockResolvedValueOnce(null)
        const unauthorized = await POST(request({}, 'https://crm.example'), context)
        expect(unauthorized.status).toBe(401)

        const crossOrigin = await POST(request({}, 'https://attacker.example'), context)
        expect(crossOrigin.status).toBe(403)
        expect(mocks.principal).toHaveBeenCalledTimes(1)
        expect(mocks.open).not.toHaveBeenCalled()
    })

    test.each([
        ['identity_unreachable', 'IDENTITY_UNREACHABLE'],
        ['identity_reachability_unknown', 'IDENTITY_REACHABILITY_UNKNOWN'],
        ['identity_ambiguous', 'IDENTITY_AMBIGUOUS'],
        ['identity_conflicted', 'IDENTITY_CONFLICTED'],
        ['provider_account_unproven', 'PROVIDER_ACCOUNT_UNPROVEN'],
        ['transport_unbound', 'TRANSPORT_UNBOUND'],
        ['conversation_target_unproven', 'CONVERSATION_TARGET_UNPROVEN'],
    ] as const)('returns a conflict and no chat for %s', async (status, error) => {
        mocks.open.mockResolvedValue({ status })

        const response = await POST(request(), context)
        const body = await response.json()

        expect(response.status).toBe(409)
        expect(body).toMatchObject({ error })
        expect(body.chat).toBeUndefined()
        expect(mocks.open).toHaveBeenCalledWith({
            contactId: 'contact-1',
            channel: 'telegram',
            identityId: 'identity-1',
            phoneId: null,
        })
    })

    test('projects only a ready, exactly owned conversation', async () => {
        mocks.open.mockResolvedValue({
            status: 'ready',
            identity: { id: 'identity-1' },
            conversation: {
                id: 'chat-1',
                channel: 'telegram',
                externalChatId: 'telegram:opaque-provider-user-42',
                status: 'new',
                contactId: 'contact-1',
                contactIdentityId: 'identity-1',
            },
            isNewConversation: true,
        })

        const response = await POST(request(), context)

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            chat: {
                id: 'chat-1',
                channel: 'telegram',
                contactId: 'contact-1',
                contactIdentityId: 'identity-1',
                externalChatId: 'telegram:opaque-provider-user-42',
                status: 'new',
                isNew: true,
            },
        })
    })
})

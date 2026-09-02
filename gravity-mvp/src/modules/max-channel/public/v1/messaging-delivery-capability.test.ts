import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    register: vi.fn(),
    sendReaction: vi.fn(),
    sendTextTransport: vi.fn(),
}))

vi.mock('@/modules/max-channel/application/messaging-transport', () => ({
    sendMaxTransportTextV1: mocks.sendTextTransport,
}))
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    registerMaxChannelDeliveryV1: mocks.register,
}))
vi.mock('./reaction-delivery', () => ({ sendMaxReactionDeliveryV1: mocks.sendReaction }))

import {
    assertMaxTransportBindingV1,
    registerMaxMessagingDeliveryCapabilityV1,
} from './messaging-delivery-capability'

type RegisteredCapability = {
    sendText(input: any): Promise<Record<string, unknown>>
    sendMedia(input: any): Promise<{ externalId?: string }>
    sendReaction(input: any): Promise<{ reactionConfirmed: boolean; status?: string }>
    deleteMessage(input: any): Promise<void>
}

function registeredCapability(): RegisteredCapability {
    registerMaxMessagingDeliveryCapabilityV1()
    return mocks.register.mock.calls.at(-1)?.[0] as RegisteredCapability
}

describe('MAX provider account to transport binding', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    test('accepts only a concrete account on the personal scraper shape', () => {
        expect(() => assertMaxTransportBindingV1({
            providerAccountId: 'live-account-a',
            connectionId: 'max_scraper',
            isPersonal: true,
        })).not.toThrow()
        expect(() => assertMaxTransportBindingV1({
            providerAccountId: 'max-default',
            connectionId: 'max_scraper',
            isPersonal: true,
        })).toThrow('CONTACT_CONVERSATION_PROVIDER_ACCOUNT_UNPROVEN')
        expect(() => assertMaxTransportBindingV1({
            providerAccountId: 'live-account-a',
            connectionId: 'configured-account-a',
            isPersonal: true,
        })).toThrow('CONTACT_CONVERSATION_PROVIDER_TRANSPORT_MISMATCH')
    })

    test('keeps unimplemented bot delivery fail closed', () => {
        expect(() => assertMaxTransportBindingV1({
            providerAccountId: 'bot-a',
            connectionId: 'bot-a',
            isPersonal: false,
        })).toThrow('MAX_BOT_DELIVERY_TRANSPORT_UNAVAILABLE')
        expect(() => assertMaxTransportBindingV1({
            providerAccountId: 'bot-b',
            connectionId: 'bot-a',
            isPersonal: false,
        })).toThrow('CONTACT_CONVERSATION_PROVIDER_TRANSPORT_MISMATCH')
    })

    test('forwards exact personal text binding only through the server-only transport', async () => {
        const capability = registeredCapability()
        mocks.sendTextTransport.mockResolvedValue({
            success: true,
            externalId: 'd301abcd',
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
            providerAccountId: 'live-account-a',
        })

        await expect(capability.sendText({
            target: '902454841098',
            content: 'hello',
            options: {
                providerAccountId: 'live-account-a',
                connectionId: 'max_scraper',
                isPersonal: true,
                clientMessageId: 'client-1',
            },
        })).resolves.toEqual({
            outcome: 'delivered',
            externalId: 'd301abcd',
            resolvedChatId: null,
        })
        expect(mocks.sendTextTransport).toHaveBeenCalledWith(expect.objectContaining({
            providerAccountId: 'live-account-a',
            connectionId: 'max_scraper',
            isPersonal: true,
            clientMessageId: 'client-1',
        }))
    })

    test('rejects text results without the requested live account proof', async () => {
        const capability = registeredCapability()
        mocks.sendTextTransport.mockResolvedValue({ success: true, deliveryStatus: 'send_requested' })

        await expect(capability.sendText({
            target: '902454841098',
            content: 'hello',
            options: {
                providerAccountId: 'live-account-a',
                connectionId: 'max_scraper',
                isPersonal: true,
            },
        })).rejects.toThrow('MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH')
    })

    test('sends media with the exact account and verifies the scraper echo', async () => {
        const capability = registeredCapability()
        const providerFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({
                externalId: 'd301abcd',
                providerAccountId: 'live-account-a',
            }),
        })
        vi.stubGlobal('fetch', providerFetch)

        await expect(capability.sendMedia({
            chatId: 'conversation-1',
            base64: 'ZmFrZQ==',
            filename: 'photo.png',
            mimeType: 'image/png',
            caption: 'caption',
            mediaType: 'image',
            providerAccountId: 'live-account-a',
            connectionId: 'max_scraper',
            isPersonal: true,
        })).resolves.toEqual({ externalId: 'd301abcd' })

        expect(providerFetch).toHaveBeenCalledWith(
            expect.stringContaining('/send-media'),
            expect.objectContaining({
                body: JSON.stringify({
                    chatId: 'conversation-1',
                    base64: 'ZmFrZQ==',
                    filename: 'photo.png',
                    mimeType: 'image/png',
                    caption: 'caption',
                    mediaType: 'image',
                    providerAccountId: 'live-account-a',
                }),
            }),
        )
    })

    test('rejects media proof from another authenticated account', async () => {
        const capability = registeredCapability()
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({ providerAccountId: 'live-account-b' }),
        }))

        await expect(capability.sendMedia({
            chatId: 'conversation-1',
            base64: 'ZmFrZQ==',
            filename: 'photo.png',
            mimeType: 'image/png',
            caption: '',
            mediaType: 'image',
            providerAccountId: 'live-account-a',
            connectionId: 'max_scraper',
            isPersonal: true,
        })).rejects.toThrow('MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH')
    })

    test('forwards the exact account to reaction delivery', async () => {
        const capability = registeredCapability()
        mocks.sendReaction.mockResolvedValue({ reactionConfirmed: false, status: 'send_requested' })

        await capability.sendReaction({
            chatId: 'conversation-1',
            messageId: 'd301abcd',
            emoji: '👍',
            remove: false,
            providerAccountId: 'live-account-a',
            connectionId: 'max_scraper',
            isPersonal: true,
        })

        expect(mocks.sendReaction).toHaveBeenCalledWith(expect.objectContaining({
            providerAccountId: 'live-account-a',
        }))
    })
})

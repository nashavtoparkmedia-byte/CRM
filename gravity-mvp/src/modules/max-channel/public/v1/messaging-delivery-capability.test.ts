import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    register: vi.fn(),
    sendReaction: vi.fn(),
    sendTextTransport: vi.fn(),
}))

vi.mock('@/modules/max-channel/application/messaging-transport', async () => {
    const actual = await vi.importActual<typeof import('@/modules/max-channel/application/messaging-transport')>(
        '@/modules/max-channel/application/messaging-transport',
    )
    return {
        maxTextSendFailureMessageV1: actual.maxTextSendFailureMessageV1,
        sendMaxTransportTextV1: mocks.sendTextTransport,
    }
})
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
        // Account provenance is deferred and no longer admits or rejects a
        // binding; the personal transport shape is still enforced exactly.
        expect(() => assertMaxTransportBindingV1({
            providerAccountId: null,
            connectionId: 'max_scraper',
            isPersonal: true,
        })).not.toThrow()
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
        // An unbound non-personal conversation still cannot route at all.
        expect(() => assertMaxTransportBindingV1({
            providerAccountId: 'bot-b',
            connectionId: undefined,
            isPersonal: false,
        })).toThrow('CONTACT_CONVERSATION_TRANSPORT_UNBOUND')
    })

    test('the scraper still requires an account to select a live personal session', () => {
        const capability = registeredCapability()
        // A transport capability requirement, not identity authority: it decides
        // whether a message can physically be sent, never whether a Contact or
        // ChannelIdentity may be admitted.
        return expect(capability.sendText({
            target: '1',
            content: 'x',
            options: { providerAccountId: null, isPersonal: true },
        })).rejects.toThrow('MAX_TRANSPORT_ACCOUNT_REQUIRED')
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

    test('a UI action without a correlated provider id is never delivered', async () => {
        // The compose box clearing was recorded as delivered for a message that
        // never left the page (2026-10-02 19:25:58). Such an answer stays pending.
        const capability = registeredCapability()
        mocks.sendTextTransport.mockResolvedValue({
            success: true,
            externalId: null,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
            providerAccountId: 'live-account-a',
            deliveryProof: { kind: 'ui_send_action', clientMessageId: 'client-1', actionConfirmed: true },
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
        })).resolves.toEqual({ outcome: 'pending', externalId: null, resolvedChatId: null })
    })

    test('a request seen on the wire without MAX\'s answer stays pending with no id', async () => {
        const capability = registeredCapability()
        mocks.sendTextTransport.mockResolvedValue({
            success: true,
            externalId: null,
            deliveryConfirmed: false,
            deliveryStatus: 'send_requested',
            proofKind: 'client_frame',
            code: 'MAX_SEND_UNCONFIRMED',
            providerAccountId: 'live-account-a',
        })

        await expect(capability.sendText({
            target: '902454841098',
            content: 'hello',
            options: { providerAccountId: 'live-account-a', connectionId: 'max_scraper', isPersonal: true },
        })).resolves.toEqual({ outcome: 'pending', externalId: null, resolvedChatId: null })
    })

    test.each([
        ['a synthetic DOM-recovery id', { quotedMsgId: 'max-dom-902454841098-0123456789abcdef', quotedText: '3' }],
        ['a quoted row with no provider id', { quotedText: 'Добрый день', quotedSentAt: '2026-10-02T19:25:24.000Z', quotedDirection: 'inbound' }],
        ['a quoted row with no provider id and no text', { quotedSentAt: '2026-10-02T19:25:24.000Z' }],
    ])('refuses a reply to %s before anything is dispatched', async (_label, quote) => {
        const capability = registeredCapability()

        await expect(capability.sendText({
            target: '902454841098',
            content: 'ответ',
            options: { providerAccountId: 'live-account-a', connectionId: 'max_scraper', isPersonal: true, ...quote },
        })).rejects.toThrow(/^MAX_REPLY_TARGET_NOT_ADDRESSABLE: .*\(MAX_SEND_REFUSED\)$/)
        expect(mocks.sendTextTransport).not.toHaveBeenCalled()
    })

    test('a reply to a real provider id goes out as a reply', async () => {
        const capability = registeredCapability()
        mocks.sendTextTransport.mockResolvedValue({
            success: true,
            externalId: 'd301a0fe1478805e09',
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
            providerAccountId: 'live-account-a',
        })

        await expect(capability.sendText({
            target: '902454841098',
            content: 'ответ',
            options: {
                providerAccountId: 'live-account-a',
                connectionId: 'max_scraper',
                isPersonal: true,
                quotedMsgId: 'd301a0fe1417a12c06',
                quotedText: '3',
                quotedSentAt: '2026-10-02T19:25:24.000Z',
                quotedDirection: 'inbound',
            },
        })).resolves.toMatchObject({ outcome: 'delivered', externalId: 'd301a0fe1478805e09' })
        expect(mocks.sendTextTransport).toHaveBeenCalledWith(expect.objectContaining({ quotedMsgId: 'd301a0fe1417a12c06' }))
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

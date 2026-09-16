import { afterEach, describe, expect, it, vi } from 'vitest'

import { sendMaxTransportTextV1 } from './messaging-transport'

describe('MAX server-only text transport', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('sends the exact account and accepts only its live scraper echo', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({
                success: true,
                deliveryStatus: 'send_requested',
                providerAccountId: 'live-account-a',
            }),
        })
        vi.stubGlobal('fetch', fetchMock)

        await expect(sendMaxTransportTextV1({
            target: '+7 999 000-00-01',
            content: 'hello',
            providerAccountId: 'live-account-a',
            connectionId: 'max_scraper',
            isPersonal: true,
            clientMessageId: 'client-1',
        })).resolves.toMatchObject({ providerAccountId: 'live-account-a' })

        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('/send-message'),
            expect.objectContaining({
                body: JSON.stringify({
                    chatId: '79990000001',
                    message: 'hello',
                    quotedMsgId: undefined,
                    uiChatId: undefined,
                    clientMessageId: 'client-1',
                    providerAccountId: 'live-account-a',
                }),
            }),
        )
    })

    it('rejects a configured-only account when the live scraper does not echo it', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({
                success: true,
                providerAccountId: 'different-live-account',
            }),
        }))

        await expect(sendMaxTransportTextV1({
            target: '79990000001',
            content: 'hello',
            providerAccountId: 'configured-account',
            connectionId: 'max_scraper',
            isPersonal: true,
        })).rejects.toThrow('MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH')
    })

    it('never simulates bot delivery success', async () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)

        await expect(sendMaxTransportTextV1({
            target: '79990000001',
            content: 'hello',
            providerAccountId: 'bot-a',
            connectionId: 'bot-a',
            isPersonal: false,
        })).rejects.toThrow('MAX_BOT_DELIVERY_TRANSPORT_UNAVAILABLE')
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

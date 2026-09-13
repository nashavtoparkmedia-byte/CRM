import { beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * Behaviour of the notification gate, asserted rather than asserted-about.
 *
 * The three properties this route exists for — no session means the login
 * screen with the target preserved, an unknown chat never opens, and the tab
 * comes from the conversation rather than the payload — are all decided here,
 * so they are all exercised here.
 */

const findUnique = vi.fn()
const getPrincipal = vi.fn()
const writeDerived = vi.fn()

vi.mock('@/lib/prisma', () => ({
    prisma: { chat: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}))

vi.mock('@/modules/identity-access/public/v1/mobile-session-auth', () => ({
    getMobileSessionPrincipalV1: () => getPrincipal(),
    writeDerivedUiIdentityCookie: (...args: unknown[]) => writeDerived(...args),
}))

const { GET } = await import('./route')

const PRINCIPAL = {
    credentialSubject: 'mobile-operator',
    runtimeOperatorId: 'u1',
    deviceId: 'a1b2c3d4',
    expiresAtSeconds: 4_000_000_000,
}

function request(url: string) {
    return new Request(url) as never
}

function location(response: Response): string {
    const raw = response.headers.get('location') ?? ''
    // Every Location this route emits must be relative, so the client resolves
    // it against the host it actually asked — behind Nginx, request.url is the
    // container address, not the public origin.
    expect(raw.startsWith('/')).toBe(true)
    return raw
}

beforeEach(() => {
    findUnique.mockReset()
    getPrincipal.mockReset()
    writeDerived.mockReset()
})

describe('GET /messages/open', () => {
    test('an unauthenticated tap goes to the mobile login carrying the target', async () => {
        getPrincipal.mockResolvedValue(null)

        const response = await GET(request('https://yokoone.ru/messages/open?chat=chat_1&msg=m9'))

        expect(response.status).toBe(303)
        expect(location(response)).toBe('/login/mobile?next=%2Fmessages%2Fopen%3Fchat%3Dchat_1%26msg%3Dm9')
        // No session means no database access at all.
        expect(findUnique).not.toHaveBeenCalled()
    })

    test('the login return destination is rebuilt from validated parts only', async () => {
        getPrincipal.mockResolvedValue(null)

        const response = await GET(request(
            'https://yokoone.ru/messages/open?chat=chat_1&phone=%2B79990000000&driver=d1&next=https%3A%2F%2Fevil.example',
        ))

        // phone, driver and a smuggled next are all absent from what comes back.
        expect(location(response)).toBe('/login/mobile?next=%2Fmessages%2Fopen%3Fchat%3Dchat_1')
    })

    test('a conversation that does not exist never opens', async () => {
        getPrincipal.mockResolvedValue(PRINCIPAL)
        findUnique.mockResolvedValue(null)

        const response = await GET(request('https://yokoone.ru/messages/open?chat=chat_missing'))

        expect(response.status).toBe(303)
        expect(location(response)).toBe('/messages?open=unavailable')
    })

    test('a payload that is not a plain identifier is refused before any lookup', async () => {
        getPrincipal.mockResolvedValue(PRINCIPAL)

        for (const chat of ['../../settings', 'https://evil.example/', 'a b', '', 'x'.repeat(65)]) {
            const response = await GET(request(
                `https://yokoone.ru/messages/open?chat=${encodeURIComponent(chat)}`,
            ))
            expect(location(response)).toBe('/messages')
        }
        expect(findUnique).not.toHaveBeenCalled()
    })

    test('the channel tab comes from the conversation, not from the payload', async () => {
        getPrincipal.mockResolvedValue(PRINCIPAL)
        findUnique.mockResolvedValue({ id: 'chat_1', channel: 'telegram' })

        // The payload claims WhatsApp; the stored channel is Telegram.
        const response = await GET(request('https://yokoone.ru/messages/open?chat=chat_1&channel=wa'))

        expect(location(response)).toBe('/messages?id=chat_1&channel=tg')
    })

    test('each stored channel maps to the tab the messenger expects', async () => {
        getPrincipal.mockResolvedValue(PRINCIPAL)
        const expected: Record<string, string> = {
            telegram: 'tg',
            whatsapp: 'wa',
            max: 'max',
            avito: 'av',
            phone: 'phone',
        }

        for (const [stored, tab] of Object.entries(expected)) {
            findUnique.mockResolvedValue({ id: 'chat_1', channel: stored })
            const response = await GET(request('https://yokoone.ru/messages/open?chat=chat_1'))
            expect(location(response)).toBe(`/messages?id=chat_1&channel=${tab}`)
        }
    })

    test('a well-formed message id is carried through and a malformed one is dropped', async () => {
        getPrincipal.mockResolvedValue(PRINCIPAL)
        findUnique.mockResolvedValue({ id: 'chat_1', channel: 'max' })

        expect(location(await GET(request('https://yokoone.ru/messages/open?chat=chat_1&msg=m9'))))
            .toBe('/messages?id=chat_1&channel=max&msg=m9')
        expect(location(await GET(request('https://yokoone.ru/messages/open?chat=chat_1&msg=..%2Fsecret'))))
            .toBe('/messages?id=chat_1&channel=max')
    })

    test('the lookup is read-only and the derived identity is refreshed from the session', async () => {
        getPrincipal.mockResolvedValue(PRINCIPAL)
        findUnique.mockResolvedValue({ id: 'chat_1', channel: 'telegram' })

        await GET(request('https://yokoone.ru/messages/open?chat=chat_1'))

        // Selecting only id and channel is what keeps this a read: nothing is
        // fetched that could tempt a later change into marking it read.
        expect(findUnique).toHaveBeenCalledWith({
            where: { id: 'chat_1' },
            select: { id: true, channel: true },
        })
        expect(writeDerived).toHaveBeenCalledWith(PRINCIPAL)
    })
})

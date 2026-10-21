import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The one way a support screenshot reaches a manager's browser.
 *
 * The browser names an application, never a file: the Telegram file id is
 * resolved on the server. So this route has to gate on the session, answer a
 * failure as a status rather than as a page, and serve bytes that nothing can
 * execute or cache.
 */

const managerSession = vi.fn()
const managerEvidence = vi.fn()

vi.mock('../../manager-data', () => ({
    managerSession: () => managerSession(),
    managerEvidence: (applicationId: string) => managerEvidence(applicationId),
}))

// The real manager-data module, loaded below with vi.importActual, reaches the
// Telegram channel and the fleet surface only through these.
const readTelegramBotFile = vi.fn()
const evidenceSource = vi.fn()
vi.mock('@/modules/telegram-channel/public/v1', () => ({
    readTelegramBotFileV1: (input: unknown) => readTelegramBotFile(input),
}))
vi.mock('@/modules/fleet-operations/public/v1', () => ({
    compensationManagerEvidenceSourceV1: (applicationId: string) => evidenceSource(applicationId),
    compensationManagerApplicationV1: vi.fn(),
    compensationManagerApplicationsV1: vi.fn(),
    compensationManagerBudgetV1: vi.fn(),
    compensationManagerPeriodKeyV1: vi.fn(),
    resolveCompensationManagerPrincipalV1: vi.fn(),
}))
vi.mock('@/modules/fleet-operations/public/v1/yandex-connection-capability', () => ({
    listYandexConnectionMetadataV1: vi.fn(),
}))
vi.mock('@/modules/identity-access/public/v1/identity-actions', () => ({
    queryCurrentUserV1: vi.fn(),
}))

import { GET } from './route'

const params = (applicationId = 'app-1') => ({ params: Promise.resolve({ applicationId }) })
const request = () => new Request('http://crm.local/compensation/app-1/evidence')

beforeEach(() => {
    vi.clearAllMocks()
    managerSession.mockResolvedValue({
        ok: true, role: 'Менеджер', principal: { principalId: 'crm_user:1', operatorLabel: 'Аня' },
    })
    managerEvidence.mockResolvedValue({
        ok: true, contentType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3, 4]),
    })
})

describe('who may see the screenshot', () => {
    it.each([
        ['not_authenticated', 401],
        ['user_disabled', 401],
        ['user_identity_incomplete', 401],
        ['role_not_allowed', 403],
    ] as const)('answers %s with %i and reads nothing', async (refusal, status) => {
        managerSession.mockResolvedValue({ ok: false, refusal })
        const response = await GET(request(), params())
        expect(response.status).toBe(status)
        expect(await response.json()).toEqual({ error: refusal })
        expect(managerEvidence).not.toHaveBeenCalled()
    })

    it('asks for the screenshot by application, never by file id', async () => {
        await GET(request(), params('app-42'))
        expect(managerEvidence).toHaveBeenCalledWith('app-42')
    })
})

describe('what comes back', () => {
    it('serves the bytes as a private, inert response', async () => {
        const response = await GET(request(), params())
        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('image/jpeg')
        expect(response.headers.get('Content-Length')).toBe('4')
        expect(response.headers.get('Cache-Control')).toBe('private, no-store')
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
        expect(response.headers.get('Content-Security-Policy')).toContain('sandbox')
        expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
    })

    it('serves a PDF support reply with the type the channel reported', async () => {
        managerEvidence.mockResolvedValue({
            ok: true, contentType: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70]),
        })
        const response = await GET(request(), params())
        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('application/pdf')
        // Still inert: a PDF served from the CRM origin must not be a document
        // the browser will run scripts for.
        expect(response.headers.get('Content-Security-Policy')).toContain('sandbox')
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    })

    it('never sends the browser to Telegram instead of answering', async () => {
        const response = await GET(request(), params())
        expect(response.status).toBeLessThan(300)
        expect(response.headers.get('Location')).toBeNull()
    })

    it.each([
        ['missing', 404],
        ['not_found', 404],
        ['unsupported_media', 415],
        ['too_large', 413],
        ['unavailable', 502],
    ] as const)('turns the %s failure into %i', async (reason, status) => {
        managerEvidence.mockResolvedValue({ ok: false, reason })
        const response = await GET(request(), params())
        expect(response.status).toBe(status)
        expect(await response.json()).toEqual({ error: reason })
    })

    it('answers an unknown failure as a gateway problem rather than as success', async () => {
        managerEvidence.mockResolvedValue({ ok: false, reason: 'something_new' })
        expect((await GET(request(), params())).status).toBe(502)
    })
})

describe('what the support reply is, read from its bytes', () => {
    const SIGNATURES = {
        jpeg: [0xff, 0xd8, 0xff, 0xe0, 0x00],
        png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00],
        gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01],
        webp: [0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56],
        pdf: [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34],
        html: [0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e],
        zip: [0x50, 0x4b, 0x03, 0x04, 0x14],
    }
    const real = () => vi.importActual<typeof import('../../manager-data')>('../../manager-data')
    const file = (contentType: string, bytes: number[]) =>
        readTelegramBotFile.mockResolvedValue({ ok: true, contentType, bytes: new Uint8Array(bytes) })

    beforeEach(() => evidenceSource.mockResolvedValue({ fileId: 'AgACAgIAAxkBAAIB-file-id' }))

    it.each([
        ['image/jpeg', SIGNATURES.jpeg, 'image/jpeg'],
        ['image/png', SIGNATURES.png, 'image/png'],
        ['image/gif', SIGNATURES.gif, 'image/gif'],
        ['image/webp', SIGNATURES.webp, 'image/webp'],
        ['application/pdf', SIGNATURES.pdf, 'application/pdf'],
        // A name that lies: the channel reports what the file was called, the bytes say what it is.
        ['image/jpeg', SIGNATURES.png, 'image/png'],
        ['image/jpeg', SIGNATURES.pdf, 'application/pdf'],
    ])('reported %s with those bytes is served as %s', async (reported, bytes, served) => {
        file(reported, bytes)
        const { managerEvidence: evidence } = await real()
        expect(await evidence('app-1')).toEqual({ ok: true, contentType: served, bytes: new Uint8Array(bytes) })
        expect(readTelegramBotFile).toHaveBeenCalledWith({ fileId: 'AgACAgIAAxkBAAIB-file-id' })
    })

    it.each([
        ['an HTML page named as a picture', 'image/jpeg', SIGNATURES.html],
        ['an archive named as a PDF', 'application/pdf', SIGNATURES.zip],
        ['a few bytes too short to be anything', 'image/png', [0x89, 0x50]],
    ])('refuses %s as unsupported', async (_label, reported, bytes) => {
        file(reported, bytes)
        const { managerEvidence: evidence } = await real()
        expect(await evidence('app-1')).toEqual({ ok: false, reason: 'unsupported_media' })
    })

    it('keeps the transport answers it already had', async () => {
        const { managerEvidence: evidence } = await real()
        evidenceSource.mockResolvedValue(null)
        expect(await evidence('app-1')).toEqual({ ok: false, reason: 'missing' })
        evidenceSource.mockResolvedValue({ fileId: 'AgACAgIAAxkBAAIB-file-id' })
        readTelegramBotFile.mockResolvedValue({ ok: false, reason: 'invalid_file_id' })
        expect(await evidence('app-1')).toEqual({ ok: false, reason: 'not_found' })
        readTelegramBotFile.mockResolvedValue({ ok: false, reason: 'too_large' })
        expect(await evidence('app-1')).toEqual({ ok: false, reason: 'too_large' })
    })
})

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

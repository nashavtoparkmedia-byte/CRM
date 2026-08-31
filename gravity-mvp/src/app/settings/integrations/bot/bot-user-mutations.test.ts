import { afterEach, describe, expect, it, vi } from 'vitest'

import { deleteBotUserMutation } from './bot-user-mutations'

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('Telegram bot user mutations', () => {
    it.each([
        { action: 'unlink' as const, telegramId: '42' },
        { action: 'dismiss' as const, requestId: 'request-1' },
    ])('rejects a failed $action response instead of reporting local success', async mutation => {
        const request = vi.fn().mockResolvedValue({
            ok: false,
            json: vi.fn().mockResolvedValue({ error: 'Forbidden' }),
        })
        vi.stubGlobal('fetch', request)

        await expect(deleteBotUserMutation(mutation)).rejects.toThrow('Forbidden')
        expect(request).toHaveBeenCalledWith('/api/bot-users', expect.objectContaining({
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mutation),
        }))
    })

    it('resolves only after a successful server mutation', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

        await expect(deleteBotUserMutation({ action: 'unlink', telegramId: '42' })).resolves.toBeUndefined()
    })
})

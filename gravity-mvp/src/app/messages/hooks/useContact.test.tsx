import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ContactProfilePayload } from '@/lib/contact-profile-contract'
import { useContact } from './useContact'

function contact(displayName: string, syncedAt: string | null = null): ContactProfilePayload {
    return {
        id: 'contact-1',
        displayName,
        syncState: { status: syncedAt ? 'ok' : 'never', lastSuccessfulAt: syncedAt, lastFailedAt: null, error: null, parks: [] },
    } as unknown as ContactProfilePayload
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 503): Response {
    return { ok, status, json: async () => body } as Response
}

describe('useContact profile refresh', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        vi.stubGlobal('fetch', vi.fn())
    })

    test('shows the Contact before refresh completes and coalesces a parallel retry', async () => {
        const fetchMock = vi.mocked(fetch)
        let resolveRefresh!: (response: Response) => void
        const pendingRefresh = new Promise<Response>(resolve => { resolveRefresh = resolve })
        let getCount = 0
        fetchMock.mockImplementation(async (_input, init) => {
            if (init?.method === 'POST') return pendingRefresh
            getCount += 1
            return jsonResponse(getCount === 1 ? contact('Before refresh') : contact('After refresh', '2026-07-13T12:00:00.000Z'))
        })

        const hook = renderHook(() => useContact('contact-1'))
        await waitFor(() => expect(hook.result.current.contact?.displayName).toBe('Before refresh'))
        expect(hook.result.current.profileSyncState).toBe('syncing')

        let parallelRetry!: Promise<void>
        act(() => { parallelRetry = hook.result.current.retryProfileSync() })
        expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)

        resolveRefresh(jsonResponse({ refreshedAt: '2026-07-13T12:00:00.000Z' }))
        await act(async () => { await parallelRetry })
        await waitFor(() => expect(hook.result.current.contact?.displayName).toBe('After refresh'))
        expect(hook.result.current.profileSyncState).toBe('success')
        expect(hook.result.current.profileSyncedAt).toBe('2026-07-13T12:00:00.000Z')
    })

    test('keeps stale Contact data after refresh failure and succeeds on explicit retry', async () => {
        const fetchMock = vi.mocked(fetch)
        let getCount = 0
        let postCount = 0
        fetchMock.mockImplementation(async (_input, init) => {
            if (init?.method === 'POST') {
                postCount += 1
                return postCount === 1
                    ? jsonResponse({ error: 'temporary' }, false)
                    : jsonResponse({ refreshedAt: '2026-07-13T13:00:00.000Z' })
            }
            getCount += 1
            return jsonResponse(getCount === 1 ? contact('Cached contact') : contact('Refreshed contact', '2026-07-13T13:00:00.000Z'))
        })

        const hook = renderHook(() => useContact('contact-1'))
        await waitFor(() => expect(hook.result.current.profileSyncState).toBe('error'))
        expect(hook.result.current.contact?.displayName).toBe('Cached contact')
        expect(hook.result.current.profileSyncError).toBe('HTTP 503')

        await act(async () => { await hook.result.current.retryProfileSync() })
        await waitFor(() => expect(hook.result.current.profileSyncState).toBe('success'))
        expect(hook.result.current.contact?.displayName).toBe('Refreshed contact')
        expect(postCount).toBe(2)
    })
})

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CONTACT_SEARCH_INVALIDATE_EVENT } from '@/lib/contact-search'
import { useContactSearch } from './useContactSearch'

describe('useContactSearch invalidation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      contacts: [{ id: 'contact-1', displayName: 'Шабуров Евгений Анатольевич' }],
      total: 1,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('reruns the current query after Contact data is refreshed', async () => {
    const { result } = renderHook(() => useContactSearch('шабу', 0))

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.total).toBe(1))

    act(() => window.dispatchEvent(new Event(CONTACT_SEARCH_INVALIDATE_EVENT)))

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/contacts/search?q=%D1%88%D0%B0%D0%B1%D1%83&limit=8',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})

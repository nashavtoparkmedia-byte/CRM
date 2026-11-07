/**
 * The one Contacts client lookup state machine, proven on its own.
 *
 * The transport is an injected fake whose answers are released by hand, so
 * every ordering of requests, answers, resets and unmounts can be driven. The
 * hook must send only what contactLookupCriteriaV1 accepts, after the debounce,
 * keep items in exactly the order received, and apply an answer only while it is
 * the newest one.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ContactLookupItemV1, ContactLookupResultV1 } from '../contact-lookup'
import { CONTACT_LOOKUP_DEBOUNCE_MS, useContactLookupV1, type ContactLookupClientV1 } from './use-contact-lookup'

function item(contactId: string, displayTitle = `Контакт ${contactId}`): ContactLookupItemV1 {
  return { contactId, displayName: displayTitle, displayTitle, primaryPhone: null, channels: [] }
}

function answer(items: ContactLookupItemV1[], truncated = false): ContactLookupResultV1 {
  return { items, total: items.length, truncated }
}

type Pending = { query: string; limit?: number; resolve: (value: ContactLookupResultV1) => void; reject: (reason: unknown) => void }

let calls: Pending[]
let lookup: ContactLookupClientV1

beforeEach(() => {
  vi.useFakeTimers()
  calls = []
  lookup = vi.fn((input: { query: string; limit?: number }) => new Promise<ContactLookupResultV1>((resolve, reject) => {
    calls.push({ ...input, resolve, reject })
  }))
})

afterEach(() => {
  vi.useRealTimers()
})

async function debounce() {
  await act(async () => { vi.advanceTimersByTime(CONTACT_LOOKUP_DEBOUNCE_MS) })
}

describe('useContactLookupV1', () => {
  it('sends nothing for a query ContactLookup.v1 refuses and stays idle', async () => {
    const { result } = renderHook(() => useContactLookupV1(lookup))
    for (const query of ['', '   ', 'И', '12', 'a\u0007b']) {
      let accepted = true
      act(() => { accepted = result.current.request(query) })
      expect(accepted).toBe(false)
      expect(result.current.status).toBe('idle')
    }
    await debounce()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('sends an accepted query once, after the debounce, exactly as given', async () => {
    const { result } = renderHook(() => useContactLookupV1(lookup))
    let accepted = false
    act(() => { accepted = result.current.request('Ив') })
    expect(accepted).toBe(true)
    expect(result.current.status).toBe('loading')

    await act(async () => { vi.advanceTimersByTime(CONTACT_LOOKUP_DEBOUNCE_MS - 1) })
    expect(lookup).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledWith({ query: 'Ив' })
  })

  it('passes a consumer limit through to the capability untouched', async () => {
    const { result } = renderHook(() => useContactLookupV1(lookup, { limit: 8 }))
    act(() => { result.current.request('+7 922') })
    await debounce()
    expect(lookup).toHaveBeenCalledWith({ query: '+7 922', limit: 8 })
  })

  it('keeps the items in exactly the order received', async () => {
    const { result } = renderHook(() => useContactLookupV1(lookup))
    act(() => { result.current.request('Ив') })
    await debounce()
    const received = [item('c-z'), item('c-a'), item('c-m')]
    await act(async () => { calls[0].resolve(answer(received, true)) })

    expect(result.current.status).toBe('success')
    expect(result.current.result?.items.map((entry) => entry.contactId)).toEqual(['c-z', 'c-a', 'c-m'])
    expect(result.current.result?.truncated).toBe(true)
  })

  it('never lets an older answer replace a newer query', async () => {
    const { result } = renderHook(() => useContactLookupV1(lookup))
    act(() => { result.current.request('Ив') })
    await debounce()
    act(() => { result.current.request('Пет') })
    await debounce()

    await act(async () => { calls[1].resolve(answer([item('newer')])) })
    await act(async () => { calls[0].resolve(answer([item('older')])) })

    expect(result.current.result?.items.map((entry) => entry.contactId)).toEqual(['newer'])
  })

  it('never lets an older failure replace a newer answer', async () => {
    const { result } = renderHook(() => useContactLookupV1(lookup))
    act(() => { result.current.request('Ив') })
    await debounce()
    act(() => { result.current.request('Пет') })
    await debounce()

    await act(async () => { calls[1].resolve(answer([item('newer')])) })
    await act(async () => { calls[0].reject(new Error('late')) })

    expect(result.current.status).toBe('success')
  })

  it('drops a pending debounce and any answer in flight on reset', async () => {
    const { result } = renderHook(() => useContactLookupV1(lookup))
    act(() => { result.current.request('Ив') })
    await debounce()
    act(() => { result.current.request('Пет') })
    act(() => { result.current.reset() })
    await debounce()
    await act(async () => { calls[0].resolve(answer([item('stale')])) })

    expect(lookup).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('idle')
    expect(result.current.result).toBeNull()
  })

  it('reports a failed or throwing transport as an error with no cause', async () => {
    const throwing: ContactLookupClientV1 = () => { throw new Error('boom') }
    const { result } = renderHook(() => useContactLookupV1(throwing))
    act(() => { result.current.request('Ив') })
    await debounce()
    await act(async () => { await Promise.resolve() })

    expect(result.current.status).toBe('error')
    expect(result.current.result).toBeNull()
  })

  it('calls onSettled for the newest request only', async () => {
    const onSettled = vi.fn()
    const { result } = renderHook(() => useContactLookupV1(lookup, { onSettled }))
    act(() => { result.current.request('Ив') })
    await debounce()
    act(() => { result.current.request('Пет') })
    await debounce()
    await act(async () => { calls[0].resolve(answer([item('older')])) })
    expect(onSettled).not.toHaveBeenCalled()

    await act(async () => { calls[1].reject(new Error('no')) })
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledWith({ status: 'error' })
  })

  it('applies nothing after unmount', async () => {
    const onSettled = vi.fn()
    const { result, unmount } = renderHook(() => useContactLookupV1(lookup, { onSettled }))
    act(() => { result.current.request('Ив') })
    await debounce()
    unmount()
    await act(async () => { calls[0].resolve(answer([item('late')])) })
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('sends nothing at all when unmounted inside the debounce', async () => {
    const { result, unmount } = renderHook(() => useContactLookupV1(lookup))
    act(() => { result.current.request('Ив') })
    unmount()
    await debounce()
    expect(lookup).not.toHaveBeenCalled()
  })
})

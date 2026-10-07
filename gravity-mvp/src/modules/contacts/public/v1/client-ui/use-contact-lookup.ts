// M3A6D useContactLookupV1 — the one Contacts client lookup state machine.
//
// Every Contacts search screen asks ContactLookup.v1 through this hook:
// ContactSelector, and the Messaging consumers whose own input also drives other
// workflows (NewChatPopover, ChatList). It owns the request lifecycle only: the
// debounce, the request sequence, the stale-answer and unmount guards, and the
// lookup status and result. It owns no input, no selection and no workflow.
//
// It decides nothing about Contacts. Whether a query may be sent is
// contactLookupCriteriaV1's answer; ranking, order, the limit bounds and the
// provider-neutral display all come from ContactLookup.v1, and the items are kept
// exactly in the order received. Transport cancellation is not relied upon,
// because an injected lookup need not support it: every request, and every reset,
// takes a new sequence number, and an answer is applied only while its number is
// still the latest.

import { useCallback, useEffect, useRef, useState } from 'react'

import { contactLookupCriteriaV1, type ContactLookupResultV1 } from '../contact-lookup'

/** The injected transport for ContactLookup.v1. */
export type ContactLookupClientV1 = (input: { query: string; limit?: number }) => Promise<ContactLookupResultV1>

/** A fixed operator-lookup debounce, matching the existing contact search hook. */
export const CONTACT_LOOKUP_DEBOUNCE_MS = 300

export type ContactLookupStatusV1 = 'idle' | 'loading' | 'success' | 'error'

/** How the newest request ended, for a consumer that reacts in the same update. */
export type ContactLookupSettledV1 =
  | { status: 'success'; result: ContactLookupResultV1 }
  | { status: 'error' }

export type ContactLookupOptionsV1 = {
  /** Passed to ContactLookup.v1 as given; the capability clamps it. Omitted, the capability default applies. */
  limit?: number
  /** Called when the newest request settles, never for a stale or unmounted one. */
  onSettled?: (settled: ContactLookupSettledV1) => void
}

export type ContactLookupStateV1 = {
  status: ContactLookupStatusV1
  /** The newest settled answer, null while idle, loading or failed. */
  result: ContactLookupResultV1 | null
  /**
   * Starts a lookup for `query` after the debounce, superseding any request in
   * flight. Answers false, and leaves the state idle, when contactLookupCriteriaV1
   * refuses the query: nothing is sent for it.
   */
  request: (query: string) => boolean
  /** Supersedes any request in flight and returns to idle. */
  reset: () => void
}

export function useContactLookupV1(lookup: ContactLookupClientV1, options: ContactLookupOptionsV1 = {}): ContactLookupStateV1 {
  const { limit } = options
  const [status, setStatus] = useState<ContactLookupStatusV1>('idle')
  const [result, setResult] = useState<ContactLookupResultV1 | null>(null)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sequenceRef = useRef(0)
  const mountedRef = useRef(true)
  const onSettledRef = useRef(options.onSettled)
  onSettledRef.current = options.onSettled

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    sequenceRef.current += 1
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cancelPending()
    }
  }, [cancelPending])

  const reset = useCallback(() => {
    cancelPending()
    setStatus('idle')
    setResult(null)
  }, [cancelPending])

  const runLookup = useCallback((query: string, sequence: number) => {
    let pending: Promise<ContactLookupResultV1>
    try {
      pending = Promise.resolve(lookup(limit === undefined ? { query } : { query, limit }))
    } catch {
      pending = Promise.reject(new Error('lookup failed'))
    }
    pending.then(
      (received) => {
        if (!mountedRef.current || sequence !== sequenceRef.current) return
        const receivedItems = Array.isArray(received?.items) ? received.items : []
        const settled = { items: receivedItems, total: receivedItems.length, truncated: received?.truncated === true }
        setResult(settled)
        setStatus('success')
        onSettledRef.current?.({ status: 'success', result: settled })
      },
      () => {
        if (!mountedRef.current || sequence !== sequenceRef.current) return
        // The cause is deliberately not kept: a server message is not operator text.
        setResult(null)
        setStatus('error')
        onSettledRef.current?.({ status: 'error' })
      },
    )
  }, [lookup, limit])

  const request = useCallback((query: string) => {
    reset()
    if (contactLookupCriteriaV1(query) === null) return false
    const sequence = sequenceRef.current
    setStatus('loading')
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      runLookup(query, sequence)
    }, CONTACT_LOOKUP_DEBOUNCE_MS)
    return true
  }, [reset, runLookup])

  return { status, result, request, reset }
}

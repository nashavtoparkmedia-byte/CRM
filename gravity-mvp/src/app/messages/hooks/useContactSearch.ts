"use client"

import { useState, useEffect, useRef, useCallback } from "react"

export interface ContactSearchPhone {
  id: string
  phone: string
  isPrimary: boolean
  source: string
}

export interface ContactSearchIdentity {
  id: string
  channel: string
  externalId: string
}

export interface ContactSearchResult {
  id: string
  displayName: string | null
  masterSource: string
  phones: ContactSearchPhone[]
  identities: ContactSearchIdentity[]
  channels: string[]
  hasChat: Record<string, string>
}

interface SearchState {
  results: ContactSearchResult[]
  loading: boolean
  total: number
}

export function useContactSearch(query: string, debounceMs = 300) {
  const [state, setState] = useState<SearchState>({ results: [], loading: false, total: 0 })
  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const search = useCallback(async (q: string) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setState(s => ({ ...s, loading: true }))

    try {
      const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(q)}&limit=8`, {
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!controller.signal.aborted) {
        setState({ results: data.contacts || [], total: data.total || 0, loading: false })
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        setState(s => ({ ...s, loading: false }))
      }
    }
  }, [])

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)

    const trimmed = query.trim()
    if (!trimmed || trimmed.length < 2) {
      abortRef.current?.abort()
      setState({ results: [], loading: false, total: 0 })
      return
    }

    setState(s => ({ ...s, loading: true }))
    timerRef.current = setTimeout(() => search(trimmed), debounceMs)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [query, debounceMs, search])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return state
}

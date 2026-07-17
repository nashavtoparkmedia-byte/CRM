/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback, useRef } from 'react'
import type {
    ContactChatPayload,
    ContactDriverProfilePayload,
    ContactIdentityPayload,
    ContactPhonePayload,
    ContactProfilePayload,
} from '@/lib/contact-profile-contract'

export type ContactPhone = ContactPhonePayload
export type ContactIdentity = ContactIdentityPayload
export type ContactChat = ContactChatPayload
export type ContactDriver = ContactDriverProfilePayload
export type SuggestedDriverProfile = ContactDriverProfilePayload
export type Contact = ContactProfilePayload

/**
 * Hook to fetch full Contact data from /api/contacts/:id.
 * Does not fetch if contactId is null/undefined.
 * Refetches when contactId changes. Aborts stale requests.
 */
export function useContact(contactId: string | null | undefined) {
    const [contact, setContact] = useState<Contact | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [profileSyncState, setProfileSyncState] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle')
    const [profileSyncError, setProfileSyncError] = useState<string | null>(null)
    const [profileSyncedAt, setProfileSyncedAt] = useState<string | null>(null)
    const abortRef = useRef<AbortController | null>(null)
    const activeContactIdRef = useRef<string | null>(null)
    const refreshPromiseRef = useRef<{ contactId: string; promise: Promise<void> } | null>(null)

    const fetchContact = useCallback(async (id: string, signal?: AbortSignal): Promise<Contact | null> => {
        const response = await fetch(`/api/contacts/${id}`, { signal })
        if (response.status === 404) return null
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
    }, [])

    const refreshProfiles = useCallback((
        id: string,
        signal?: AbortSignal,
        force = false,
        parkCode?: string,
    ): Promise<void> => {
        const current = refreshPromiseRef.current
        if (current?.contactId === id) return current.promise

        setProfileSyncState('syncing')
        setProfileSyncError(null)
        const promise = (async () => {
            try {
                const refreshResponse = await fetch(`/api/contacts/${id}/driver-profiles/refresh`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ force, parkCode }),
                    signal,
                })
                if (!refreshResponse.ok) throw new Error(`HTTP ${refreshResponse.status}`)
                const refreshResult = await refreshResponse.json().catch(() => ({}))
                const refreshedContact = await fetchContact(id, signal)
                if (!signal?.aborted && activeContactIdRef.current === id && refreshedContact) {
                    setContact(refreshedContact)
                    setProfileSyncState('success')
                    setProfileSyncedAt(refreshResult.refreshedAt || new Date().toISOString())
                }
            } catch (refreshError: any) {
                if (refreshError?.name !== 'AbortError' && activeContactIdRef.current === id) {
                    setProfileSyncState('error')
                    setProfileSyncError(refreshError?.message || 'sync_failed')
                }
            } finally {
                if (refreshPromiseRef.current?.contactId === id) refreshPromiseRef.current = null
            }
        })()
        refreshPromiseRef.current = { contactId: id, promise }
        return promise
    }, [fetchContact])

    useEffect(() => {
        if (!contactId) {
            activeContactIdRef.current = null
            setContact(null)
            setIsLoading(false)
            setError(null)
            setProfileSyncState('idle')
            setProfileSyncError(null)
            setProfileSyncedAt(null)
            return
        }

        activeContactIdRef.current = contactId
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        setIsLoading(true)
        setError(null)

        fetchContact(contactId, controller.signal)
            .then(async data => {
                if (!controller.signal.aborted && data) {
                    setContact(data)
                    setProfileSyncedAt(data.syncState?.lastSuccessfulAt || null)
                    await refreshProfiles(contactId, controller.signal)
                } else if (!controller.signal.aborted) {
                    setContact(null)
                }
            })
            .catch(err => {
                if (err.name !== 'AbortError') {
                    console.error('[useContact] fetch error:', err.message)
                    setError(err.message)
                    setContact(null)
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) {
                    setIsLoading(false)
                }
            })

        return () => { controller.abort() }
    }, [contactId, fetchContact, refreshProfiles])

    const refetch = useCallback(async () => {
        if (!contactId) return null
        setIsLoading(true)
        setError(null)
        try {
            const data = await fetchContact(contactId)
            if (activeContactIdRef.current === contactId) setContact(data)
            return data
        } catch (refetchError: any) {
            setError(refetchError?.message || 'fetch_failed')
            return null
        } finally {
            if (activeContactIdRef.current === contactId) setIsLoading(false)
        }
    }, [contactId, fetchContact])

    const retryProfileSync = useCallback(async (parkCode?: string) => {
        if (!contactId) return
        await refreshProfiles(contactId, undefined, true, parkCode)
    }, [contactId, refreshProfiles])

    return { contact, isLoading, error, refetch, retryProfileSync, profileSyncState, profileSyncError, profileSyncedAt }
}

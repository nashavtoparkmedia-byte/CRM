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

type ContactRedirectPayload = {
    status?: string
    code?: string
    canonicalContactId?: string
}

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
    const [resolvedContactRequest, setResolvedContactRequest] = useState<{
        requestedId: string; resolvedId: string | null
    } | null>(null)
    const abortRef = useRef<AbortController | null>(null)
    const activeContactIdRef = useRef<string | null>(null)
    const refreshPromiseRef = useRef<{ contactId: string; promise: Promise<void> } | null>(null)

    const fetchContact = useCallback(async function fetchContactById(
        id: string,
        signal?: AbortSignal,
        visited: string[] = [],
    ): Promise<Contact | null> {
        if (visited.includes(id) || visited.length >= 16) {
            throw new Error('CONTACT_MERGE_REDIRECT_LOOP')
        }
        const response = await fetch(`/api/contacts/${id}`, {
            signal,
            cache: 'no-store',
        })
        if (response.status === 404) return null
        if (response.status === 409) {
            const redirect = await response.json().catch(() => ({})) as ContactRedirectPayload
            if (
                redirect.status === 'merged_contact'
                && redirect.code === 'CONTACT_MERGED'
                && redirect.canonicalContactId
            ) {
                return fetchContactById(redirect.canonicalContactId, signal, [...visited, id])
            }
            throw new Error(redirect.code || `HTTP ${response.status}`)
        }
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
            setResolvedContactRequest(null)
            return
        }

        activeContactIdRef.current = contactId
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        setIsLoading(true)
        setError(null)
        setResolvedContactRequest(null)

        fetchContact(contactId, controller.signal)
            .then(async data => {
                if (!controller.signal.aborted && data) {
                    activeContactIdRef.current = data.id
                    setContact(data)
                    setProfileSyncedAt(data.syncState?.lastSuccessfulAt || null)
                    setResolvedContactRequest({ requestedId: contactId, resolvedId: data.id })
                    await refreshProfiles(data.id, controller.signal)
                } else if (!controller.signal.aborted) {
                    setContact(null)
                    setResolvedContactRequest({ requestedId: contactId, resolvedId: null })
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
            if (
                activeContactIdRef.current === contactId
                || (data && activeContactIdRef.current === data.id)
            ) {
                setContact(data)
                setResolvedContactRequest({ requestedId: contactId, resolvedId: data?.id || null })
            }
            return data
        } catch (refetchError: any) {
            setError(refetchError?.message || 'fetch_failed')
            return null
        } finally {
            if (activeContactIdRef.current === contactId) setIsLoading(false)
        }
    }, [contactId, fetchContact])

    const retryProfileSync = useCallback(async (parkCode?: string) => {
        const effectiveContactId = contact?.id || contactId
        if (!effectiveContactId) return
        await refreshProfiles(effectiveContactId, undefined, true, parkCode)
    }, [contact?.id, contactId, refreshProfiles])

    const resolvedContactId = resolvedContactRequest && resolvedContactRequest.requestedId === contactId
        ? resolvedContactRequest.resolvedId
        : null

    return { contact, resolvedContactId, isLoading, error, refetch, retryProfileSync, profileSyncState, profileSyncError, profileSyncedAt }
}

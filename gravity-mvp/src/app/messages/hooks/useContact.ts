/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback, useRef } from 'react'

export interface ContactPhone {
    id: string
    phone: string
    label: string | null
    isPrimary: boolean
    source: string
    isTemporary?: boolean
    expiresAt?: string | null
    isActive?: boolean
}

export interface ContactIdentity {
    id: string
    channel: string
    externalId: string
    phoneId: string | null
    displayName: string | null
    source: string
    confidence: number
    reachabilityStatus: 'confirmed' | 'unreachable' | 'unknown'
    reachabilityCheckedAt: string | null
    metadata?: Record<string, string | null> | null
}

export interface ContactChat {
    id: string
    channel: string
    externalChatId: string
    contactIdentityId: string | null
    lastMessageAt: string | null
    unreadCount: number
    status: string
    name: string | null
}

export interface ContactDriver {
    id: string
    yandexDriverId?: string
    fullName: string
    phone: string | null
    segment: string
    score: number | null
    lastExternalPark?: string | null
    parkName?: string | null
    status?: 'working' | 'dismissed' | 'unknown'
    isMain?: boolean
    licenseNumber?: string | null
    lastOrderAt: string | null
    hiredAt: string | null
    dismissedAt: string | null
}

export interface ContactProfileAnomaly {
    park: string
    activeCount: number
    driverIds: string[]
}

export interface Contact {
    id: string
    displayName: string
    displayNameSource: string
    masterSource: string
    yandexDriverId: string | null
    mainDriverId?: string | null
    mainDriverSelection?: string
    primaryPhoneId: string | null
    notes: string | null
    tags: string[]
    customFields: Record<string, any>
    isArchived: boolean
    createdAt: string
    updatedAt: string
    phones: ContactPhone[]
    identities: ContactIdentity[]
    chats: ContactChat[]
    driver: ContactDriver | null
    mainDriver?: ContactDriver | null
    driverProfiles?: ContactDriver[]
    profileAnomalies?: ContactProfileAnomaly[]
    mergeHistory: any[]
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
    const abortRef = useRef<AbortController | null>(null)

    useEffect(() => {
        if (!contactId) {
            setContact(null)
            setIsLoading(false)
            setError(null)
            setProfileSyncState('idle')
            setProfileSyncError(null)
            setProfileSyncedAt(null)
            return
        }

        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        setIsLoading(true)
        setError(null)

        fetch(`/api/contacts/${contactId}`, { signal: controller.signal })
            .then(res => {
                if (res.status === 404) {
                    setContact(null)
                    return null
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                return res.json()
            })
            .then(async data => {
                if (!controller.signal.aborted && data) {
                    setContact(data)
                    setProfileSyncState('syncing')
                    setProfileSyncError(null)
                    try {
                        const refreshRes = await fetch(`/api/contacts/${contactId}/driver-profiles/refresh`, { method: 'POST' })
                        if (!refreshRes.ok) throw new Error(`HTTP ${refreshRes.status}`)
                        const refreshed = await fetch(`/api/contacts/${contactId}`, { signal: controller.signal })
                        if (!refreshed.ok) throw new Error(`HTTP ${refreshed.status}`)
                        const refreshedData = await refreshed.json()
                        if (!controller.signal.aborted) {
                            setContact(refreshedData)
                            setProfileSyncState('success')
                            setProfileSyncedAt(new Date().toISOString())
                        }
                    } catch (syncErr: any) {
                        if (!controller.signal.aborted) {
                            setProfileSyncState('error')
                            setProfileSyncError(syncErr?.message || 'sync_failed')
                        }
                    }
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
    }, [contactId])

    const refetch = useCallback(() => {
        if (!contactId) return
        // Trigger re-fetch by toggling a state — simplest approach
        // Actually, just re-run the effect by using a workaround
        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        setIsLoading(true)
        setError(null)

        fetch(`/api/contacts/${contactId}`, { signal: controller.signal })
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                return res.json()
            })
            .then(data => {
                if (!controller.signal.aborted) setContact(data)
            })
            .catch(err => {
                if (err.name !== 'AbortError') {
                    setError(err.message)
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) setIsLoading(false)
            })
    }, [contactId])

    return { contact, isLoading, error, refetch, profileSyncState, profileSyncError, profileSyncedAt }
}

import { useState, useEffect, useCallback, useRef } from 'react'

export type ParkCheckViewStatus = 'complete' | 'partial' | 'failed' | 'unknown'

/** Legacy snapshots predate an explicit completeness marker and must never be
 * upgraded to an authoritative complete/not-found result by absence alone. */
export function normalizeParkCheckViewStatus(snapshot: unknown): ParkCheckViewStatus {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return 'unknown'
    const candidate = snapshot as Record<string, unknown>
    if (candidate.checkStatus === 'complete' || candidate.checkStatus === 'partial' || candidate.checkStatus === 'failed') {
        return candidate.checkStatus
    }
    const errors = Array.isArray(candidate.errors) ? candidate.errors.length : 0
    if (errors === 0) return 'unknown'
    const checkedParks = typeof candidate.checkedParks === 'number' && Number.isFinite(candidate.checkedParks)
        ? candidate.checkedParks
        : 0
    const resultCount = Array.isArray(candidate.results) ? candidate.results.length : 0
    return checkedParks > 0 || resultCount > 0 ? 'partial' : 'failed'
}

export interface ContactPhone {
    id: string
    phone: string
    label: string | null
    isPrimary: boolean
    source: string
    isTemporary?: boolean
    expiresAt?: string | null
    isActive?: boolean
    lifecycle?: 'current' | 'superseded' | 'removed' | 'unknown'
    trust?: 'provider_bound' | 'manually_verified' | 'source_asserted' | 'claimed' | 'unknown'
    freshness?: 'fresh' | 'stale' | 'unknown'
    resolutionState?: 'unique' | 'shared' | 'disputed' | 'unknown'
    verifiedAt?: string | null
    verifiedBy?: string | null
    verificationBasis?: string | null
    audits?: Array<{ id: string; actor: string; basis: string; action: string; createdAt: string }>
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
    metadata?: Record<string, unknown> | null
    providerAccountId?: string
    origin?: string
    evidenceRoot?: string | null
    conflictState?: 'clear' | 'conflicted'
    isActive?: boolean
    createdAt?: string
    aliases?: Array<{
        id?: string
        type?: string
        aliasType?: string
        value?: string
        aliasValue?: string
        provenance?: string
        evidenceRoot?: string | null
        observedAt?: string
        active?: boolean
    }>
    conflicts?: Array<{ id?: string; conflictType?: string; detectedAt?: string; status?: string }>
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
    fullName: string
    phone: string | null
    segment: string
    score: number | null
    lastOrderAt: string | null
    hiredAt: string | null
    dismissedAt: string | null
    externalParkId?: string | null
    externalDriverProfileId?: string | null
    externalPersonKey?: string | null
    personKeyType?: string | null
    personResolutionStatus?: string | null
    personResolutionBasis?: string | null
    personResolutionAt?: string | null
    personResolvedBy?: string | null
    licenseNumber?: string | null
    normalizedVu?: string | null
    legalRole?: string | null
    workStatus?: string | null
    currentStatus?: string | null
    sourceStatus?: string | null
    sourceCity?: string | null
    sourceProfileType?: string | null
    sourceFreshness?: 'fresh' | 'stale' | 'unknown'
    sourceState?: 'current' | 'stale' | 'failed' | 'unknown'
    sourcePhones?: string[]
    sourceDates?: Record<string, string | null>
    lastObservedAt?: string | null
    lastSynchronizedAt?: string | null
    createdAt?: string
    updatedAt?: string
    park?: { id: string; parkName: string; externalParkId: string } | null
    sourceConflict?: unknown
    licenseObservations?: unknown[]
}

export interface CanonicalContactSummary {
    displayName: string
    primaryPhone: string | null
    displayTitle: string
    currentMainDriverProfile: {
        id: string
        fullName: string
        phone: string | null
        segment: string | null
    } | null
    currentChannel: string | null
    providerIdentities: { channel: string; externalId: string; displayName: string | null }[]
    channelCount: number
}

export interface Contact {
    id: string
    displayName: string
    displayNameSource: string
    masterSource: string
    yandexDriverId: string | null
    primaryPhoneId: string | null
    notes: string | null
    tags: string[]
    customFields: Record<string, any>
    isArchived: boolean
    createdAt: string
    updatedAt: string
    phones: ContactPhone[]
    identities: ContactIdentity[]
    channelIdentities?: ContactIdentity[]
    chats: ContactChat[]
    driver: ContactDriver | null
    driverProfiles?: ContactDriver[]
    driverConfirmations?: Array<{ id: string; status: string; confirmedBy: string; confirmedAt: string; confirmationBasis: string }>
    identityConflicts?: Array<{ id: string; conflictType: string; detectedAt: string }>
    driverSummary?: { profileCount: number; parkCount: number; staleCount: number; failedCount: number }
    canonicalSummary?: CanonicalContactSummary
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
    const abortRef = useRef<AbortController | null>(null)

    useEffect(() => {
        if (!contactId) {
            setContact(null)
            setIsLoading(false)
            setError(null)
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
            .then(data => {
                if (!controller.signal.aborted && data) {
                    setContact(data)
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

    return { contact, isLoading, error, refetch }
}

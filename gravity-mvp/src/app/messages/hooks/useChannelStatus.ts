import { useState, useEffect, useRef } from 'react'

interface ChannelDeliveryStatus {
    status: string
    error: string | null
    sentAt: string
}

export type ChannelStatusMap = Record<string, ChannelDeliveryStatus | null>

/**
 * Fetches last outbound message status per channel for a contact.
 * Used by ProfileDrawer to show delivery errors.
 */
export function useChannelStatus(contactId: string | null | undefined) {
    const [channelStatus, setChannelStatus] = useState<ChannelStatusMap>({})
    const [isLoading, setIsLoading] = useState(false)
    const abortRef = useRef<AbortController | null>(null)

    useEffect(() => {
        if (!contactId) {
            setChannelStatus({})
            return
        }

        abortRef.current?.abort()
        const controller = new AbortController()
        abortRef.current = controller

        setIsLoading(true)

        fetch(`/api/contacts/${contactId}/channel-status`, { signal: controller.signal })
            .then(res => {
                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                return res.json()
            })
            .then(data => {
                if (!controller.signal.aborted) {
                    setChannelStatus(data)
                }
            })
            .catch(err => {
                if (err.name !== 'AbortError') {
                    console.error('[useChannelStatus] Error:', err.message)
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) setIsLoading(false)
            })

        return () => { controller.abort() }
    }, [contactId])

    return { channelStatus, isLoading }
}

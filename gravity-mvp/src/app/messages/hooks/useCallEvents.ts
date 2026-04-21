"use client"

import { useState, useEffect, useRef } from "react"
import { refreshConversations } from "./useConversations"

export interface ActiveCall {
    callSessionId: string
    direction: 'inbound' | 'outbound'
    phoneNumber: string
    contactName?: string
    contactId?: string
    status: 'ringing' | 'active'
    startedAt: number // Date.now()
}

export function useCallEvents() {
    const [activeCall, setActiveCall] = useState<ActiveCall | null>(null)
    const ref = useRef(activeCall)
    ref.current = activeCall

    useEffect(() => {
        const es = new EventSource('/api/telephony/events/stream')

        es.onmessage = (e) => {
            try {
                const { type, data } = JSON.parse(e.data)
                if (type === 'call:ringing') {
                    setActiveCall({
                        callSessionId: data.callSessionId,
                        direction: data.direction,
                        phoneNumber: data.phoneNumber,
                        contactName: data.contactName,
                        contactId: data.contactId,
                        status: 'ringing',
                        startedAt: Date.now(),
                    })
                } else if (type === 'call:answered') {
                    setActiveCall(prev =>
                        prev?.callSessionId === data.callSessionId
                            ? { ...prev, status: 'active' as const }
                            : prev
                    )
                } else if (type === 'call:ended') {
                    setActiveCall(null)
                    refreshConversations()
                }
            } catch { /* malformed SSE data */ }
        }

        es.onerror = () => {
            // Connection lost — conservatively clear active call
            setActiveCall(null)
        }

        // Timeout guard: clear stale calls
        const guard = setInterval(() => {
            const ac = ref.current
            if (!ac) return
            const age = Date.now() - ac.startedAt
            if (ac.status === 'ringing' && age > 120_000) setActiveCall(null)
            if (ac.status === 'active' && age > 3_600_000) setActiveCall(null)
        }, 10_000)

        return () => {
            es.close()
            clearInterval(guard)
        }
    }, [])

    return { activeCall }
}

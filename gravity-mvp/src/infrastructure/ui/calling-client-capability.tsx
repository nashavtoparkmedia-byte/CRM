"use client"

import React, { createContext, useContext } from 'react'

export type CallingClientRegistrationStatus =
    | 'idle'
    | 'connecting'
    | 'registered'
    | 'unregistered'
    | 'failed'
    | 'disabled'
    | 'identity-required'

export interface OutboundCallingClientCapability {
    status: CallingClientRegistrationStatus
    hasActiveCall: boolean
    startPlaceholderOutbound(phoneNumber: string, displayName?: string | null): void
    cancelPlaceholderOutbound(): void
    setActiveCallFsUuid(fsUuid: string): void
}

const OutboundCallingClientContext = createContext<OutboundCallingClientCapability | null>(null)

export function OutboundCallingClientProvider({
    children,
    value,
}: {
    children: React.ReactNode
    value: OutboundCallingClientCapability
}) {
    return (
        <OutboundCallingClientContext.Provider value={value}>
            {children}
        </OutboundCallingClientContext.Provider>
    )
}

export function useOutboundCallingClient(): OutboundCallingClientCapability {
    const capability = useContext(OutboundCallingClientContext)
    if (!capability) {
        throw new Error('useOutboundCallingClient must be used inside SipProvider')
    }
    return capability
}

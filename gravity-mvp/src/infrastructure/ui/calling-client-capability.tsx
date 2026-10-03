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

/**
 * How outbound calling is presented on this client, which is NOT the same
 * question as which platform it runs on.
 *
 * `softphone` is the browser path: the registered WebRTC softphone places the
 * call through the server's originate endpoint. `system_dialer` means this
 * client has no usable softphone and the operator is handed the number to dial
 * on their own device instead.
 *
 * Consumers outside Calling learn the mode and nothing else. They do not learn
 * the platform, the User-Agent or how the mode was decided, so a second shell
 * detector can never grow on this side of the seam.
 */
export type OutboundCallingMode =
    | 'softphone'
    | 'system_dialer'

export interface OutboundCallingClientCapability {
    status: CallingClientRegistrationStatus
    outboundMode: OutboundCallingMode
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

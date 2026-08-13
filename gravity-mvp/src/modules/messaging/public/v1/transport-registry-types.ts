export type TransportConnectionStateV1 =
    | 'initializing'
    | 'ready'
    | 'reconnecting'
    | 'failed'
    | 'stopped'

export interface TransportConnectionEntryV1 {
    readonly connectionId: string
    readonly channel: 'whatsapp' | 'telegram'
    readonly instanceId: string | null
    readonly state: TransportConnectionStateV1
    readonly lastSeen: Date | null
    readonly lastError: string | null
    readonly retryAttempt: number
    readonly startedAt: Date
    readonly readyAt: Date | null
    readonly reconnectInFlight: boolean
    readonly degradedAt: Date | null
}

/** Maps owner-local registry state to the versioned public view. */
export function projectTransportConnectionEntryV1(entry: {
    connectionId: string
    channel: 'whatsapp' | 'telegram'
    instanceId: string | null
    state: TransportConnectionStateV1
    lastSeen: Date | null
    lastError: string | null
    retryAttempt: number
    startedAt: Date
    readyAt: Date | null
    reconnectInFlight: boolean
    degradedAt: Date | null
}): TransportConnectionEntryV1 {
    return Object.freeze({
        connectionId: entry.connectionId,
        channel: entry.channel,
        instanceId: entry.instanceId,
        state: entry.state,
        lastSeen: entry.lastSeen ? new Date(entry.lastSeen) : null,
        lastError: entry.lastError,
        retryAttempt: entry.retryAttempt,
        startedAt: new Date(entry.startedAt),
        readyAt: entry.readyAt ? new Date(entry.readyAt) : null,
        reconnectInFlight: entry.reconnectInFlight,
        degradedAt: entry.degradedAt ? new Date(entry.degradedAt) : null,
    })
}

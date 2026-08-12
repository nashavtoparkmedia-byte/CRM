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

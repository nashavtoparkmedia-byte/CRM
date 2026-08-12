import type { ConnectionEntry } from '@/lib/TransportRegistry'
import type { TransportConnectionEntryV1 } from '../public/v1/transport-registry-types'

export function projectTransportConnectionEntryV1(
    entry: ConnectionEntry,
): TransportConnectionEntryV1 {
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

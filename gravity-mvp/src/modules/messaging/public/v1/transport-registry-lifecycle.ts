import {
    beginNewInstance,
    ensureEntry,
    getAllEntries,
    getDegradedDuration,
    getEntry,
    getInstanceId,
    isCurrentInstance,
    scheduleReconnect,
    setFailed,
    setReady,
    setReconnecting,
    setStopped,
    touch,
    touchLastSeen,
} from '@/lib/TransportRegistry'
import {
    projectTransportConnectionEntryV1,
    type TransportConnectionEntryV1,
} from './transport-registry-types'

export type { TransportConnectionEntryV1 }

export const transportRegistryLifecycleV1 = Object.freeze({
    beginNewInstance: (connectionId: string): string => beginNewInstance(connectionId),
    ensureEntry: (connectionId: string, channel: 'whatsapp' | 'telegram'): void => {
        ensureEntry(connectionId, channel)
    },
    getAllEntries: (): TransportConnectionEntryV1[] => (
        getAllEntries().map(projectTransportConnectionEntryV1)
    ),
    getDegradedDuration: (connectionId: string): number | null => getDegradedDuration(connectionId),
    getEntry: (connectionId: string): TransportConnectionEntryV1 | null => {
        const entry = getEntry(connectionId)
        return entry ? projectTransportConnectionEntryV1(entry) : null
    },
    getInstanceId: (connectionId: string): string | null => getInstanceId(connectionId),
    isCurrentInstance: (connectionId: string, instanceId: string): boolean => (
        isCurrentInstance(connectionId, instanceId)
    ),
    scheduleReconnect: (
        connectionId: string,
        instanceId: string,
        reconnect: () => Promise<void>,
    ): void => scheduleReconnect(connectionId, instanceId, reconnect),
    setFailed: (connectionId: string, instanceId: string, error: string): void => (
        setFailed(connectionId, instanceId, error)
    ),
    setReady: (connectionId: string, instanceId: string): void => setReady(connectionId, instanceId),
    setReconnecting: (connectionId: string, instanceId: string): void => (
        setReconnecting(connectionId, instanceId)
    ),
    setStopped: (connectionId: string): void => setStopped(connectionId),
    touch: (connectionId: string, instanceId: string): void => touch(connectionId, instanceId),
    touchLastSeen: (connectionId: string): void => touchLastSeen(connectionId),
})

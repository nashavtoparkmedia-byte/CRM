import {
    getAllEntries,
    getDegradedDuration,
} from '@/lib/TransportRegistry'
import {
    projectTransportConnectionEntryV1,
    type TransportConnectionEntryV1,
} from './transport-registry-types'

export type { TransportConnectionEntryV1 }

export const transportRegistryHealthV1 = Object.freeze({
    getAllEntries: (): TransportConnectionEntryV1[] => (
        getAllEntries().map(projectTransportConnectionEntryV1)
    ),
    getDegradedDuration: (connectionId: string): number | null => (
        getDegradedDuration(connectionId)
    ),
})

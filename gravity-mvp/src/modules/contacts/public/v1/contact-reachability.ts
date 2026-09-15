import {
    recordExactProviderReachability,
    type RecordExactProviderReachabilityCommandV1,
    type RecordExactProviderReachabilityResultV1,
} from '@/lib/ReachabilityService'

export type {
    RecordExactProviderReachabilityCommandV1,
    RecordExactProviderReachabilityResultV1,
}

export const contactReachabilityV1 = Object.freeze({
    recordExactProviderReachability: (
        command: RecordExactProviderReachabilityCommandV1,
    ): Promise<RecordExactProviderReachabilityResultV1> => (
        recordExactProviderReachability(command)
    ),
})

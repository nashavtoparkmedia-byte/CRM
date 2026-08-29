import {
    findIdentityByPhoneAndChannel,
    isReachabilityConfirmed,
    updateReachability,
    updateReachabilityByChatId,
} from '@/lib/ReachabilityService'

export type ContactReachabilityStatusV1 = 'confirmed' | 'unreachable'

export const contactReachabilityV1 = Object.freeze({
    findIdentityByPhoneAndChannel: (phone: string, channel: string): Promise<string | null> => (
        findIdentityByPhoneAndChannel(phone, channel)
    ),
    isReachabilityConfirmed: (identityId: string): Promise<boolean> => (
        isReachabilityConfirmed(identityId)
    ),
    updateReachability: (identityId: string, status: ContactReachabilityStatusV1): Promise<void> => (
        updateReachability(identityId, status)
    ),
    updateReachabilityByChatId: (chatId: string, status: ContactReachabilityStatusV1): Promise<void> => (
        updateReachabilityByChatId(chatId, status)
    ),
})

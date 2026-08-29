import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    findIdentityByPhoneAndChannel: vi.fn(),
    isReachabilityConfirmed: vi.fn(),
    updateReachability: vi.fn(),
    updateReachabilityByChatId: vi.fn(),
}))

vi.mock('@/lib/ReachabilityService', () => operations)

import { contactReachabilityV1 } from './contact-reachability'

describe('Contacts reachability capability', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('delegates the exact identity lookup and reachability updates', async () => {
        operations.findIdentityByPhoneAndChannel.mockResolvedValueOnce('identity-1')
        operations.isReachabilityConfirmed.mockResolvedValueOnce(true)

        await expect(contactReachabilityV1.findIdentityByPhoneAndChannel(
            '+79990000000',
            'telegram',
        )).resolves.toBe('identity-1')
        await expect(contactReachabilityV1.isReachabilityConfirmed('identity-1')).resolves.toBe(true)
        await contactReachabilityV1.updateReachability('identity-1', 'confirmed')
        await contactReachabilityV1.updateReachabilityByChatId('chat-1', 'unreachable')

        expect(operations.findIdentityByPhoneAndChannel).toHaveBeenCalledWith('+79990000000', 'telegram')
        expect(operations.isReachabilityConfirmed).toHaveBeenCalledWith('identity-1')
        expect(operations.updateReachability).toHaveBeenCalledWith('identity-1', 'confirmed')
        expect(operations.updateReachabilityByChatId).toHaveBeenCalledWith('chat-1', 'unreachable')
    })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    recordExactProviderReachability: vi.fn(),
}))

vi.mock('@/lib/ReachabilityService', () => operations)

import { contactReachabilityV1 } from './contact-reachability'

describe('Contacts reachability capability', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('delegates only exact provider-bound identity evidence', async () => {
        const command = {
            identityId: 'identity-1',
            contactId: 'contact-1',
            channel: 'telegram' as const,
            providerAccountId: 'telegram-account-1',
            providerTargetId: 'opaque-telegram-user-1',
            status: 'confirmed' as const,
        }
        operations.recordExactProviderReachability.mockResolvedValueOnce({
            outcome: 'updated',
            identityId: 'identity-1',
            status: 'confirmed',
        })

        await expect(contactReachabilityV1.recordExactProviderReachability(command)).resolves.toEqual({
            outcome: 'updated',
            identityId: 'identity-1',
            status: 'confirmed',
        })
        expect(operations.recordExactProviderReachability).toHaveBeenCalledWith(command)
    })
})

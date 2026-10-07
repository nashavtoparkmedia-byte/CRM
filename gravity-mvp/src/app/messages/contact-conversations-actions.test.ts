import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ contactConversations: vi.fn() }))

vi.mock('@/modules/messaging/public/v1', () => ({ contactConversationsV1: mocks.contactConversations }))

import {
    CONTACT_CONVERSATIONS_QUERY_V1,
    CONTACT_CONVERSATIONS_RESULT_V1,
    ContactConversationsQueryValidationError,
} from '@/contracts/messaging/v1'
import { readContactConversationsAction } from './contact-conversations-actions'

describe('readContactConversationsAction — transport glue only', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('passes the query to the Messaging capability as given and returns its answer unchanged', async () => {
        const answer = { contract: CONTACT_CONVERSATIONS_RESULT_V1, contacts: [{ contactId: 'missing', status: 'not_found' }] }
        mocks.contactConversations.mockResolvedValue(answer)
        const query = { contract: CONTACT_CONVERSATIONS_QUERY_V1, contactIds: ['missing'] }
        const result = await readContactConversationsAction(query)
        expect(mocks.contactConversations).toHaveBeenCalledWith(query)
        expect(result).toEqual({ ok: true, result: answer })
        if (result.ok) expect(result.result).toBe(answer)
    })

    it('answers a rejected query as invalid_query, without throwing to the page', async () => {
        mocks.contactConversations.mockRejectedValue(new ContactConversationsQueryValidationError('INVALID_CONTRACT', 'contactIds must be an array'))
        await expect(readContactConversationsAction({ contract: CONTACT_CONVERSATIONS_QUERY_V1 })).resolves.toEqual({ ok: false, error: 'invalid_query' })
    })

    it('answers any other failure as unavailable and leaks no cause to the page', async () => {
        mocks.contactConversations.mockRejectedValue(new Error('CONTACT_MERGE_REDIRECT_CYCLE'))
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const result = await readContactConversationsAction({ contract: CONTACT_CONVERSATIONS_QUERY_V1, contactIds: ['x'] })
        expect(result).toEqual({ ok: false, error: 'unavailable' })
        expect(JSON.stringify(result)).not.toContain('CYCLE')
        error.mockRestore()
    })
})

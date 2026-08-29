import { describe, expect, it, vi } from 'vitest'

const startMaxContactResolutionShadow = vi.hoisted(() => vi.fn())

vi.mock('@/lib/contacts/max-contact-resolution-shadow', () => ({ startMaxContactResolutionShadow }))

import { maxContactResolutionShadowV1 } from './max-contact-resolution-shadow'

describe('Contacts MAX resolution shadow capability', () => {
    it('delegates only the read-only shadow start operation', async () => {
        const session = { complete: vi.fn() }
        startMaxContactResolutionShadow.mockResolvedValueOnce({ session })
        const input = {
            resolutionInput: {
                channel: 'max' as const,
                externalUserId: 'max-user-1',
                externalChatId: 'max-chat-1',
                chatKind: 'private' as const,
            },
            isOutgoing: false,
            eventSource: 'live' as const,
        }

        await expect(maxContactResolutionShadowV1.start(input)).resolves.toEqual({ session })
        expect(startMaxContactResolutionShadow).toHaveBeenCalledWith(input)
    })
})

import { describe, expect, it } from 'vitest'
import { applyProviderReactionEvent } from '@/lib/provider-reaction-contract'

const observedAt = new Date('2026-07-18T12:00:00.000Z')

describe('provider reaction metadata contract', () => {
    it('does not double-count an optimistic outgoing reaction echo', () => {
        const metadata = applyProviderReactionEvent(
            { reactions: { '👍': 1 } },
            {
                provider: 'whatsapp',
                senderId: 'self@c.us',
                emoji: '👍',
                observedAt,
            },
        )

        expect(metadata.reactions).toEqual({ '👍': 1 })
    })

    it('tracks independent actors and supports reaction changes/removal', () => {
        const first = applyProviderReactionEvent({}, {
            provider: 'whatsapp',
            senderId: 'one@c.us',
            emoji: '👍',
            observedAt,
        })
        const second = applyProviderReactionEvent(first, {
            provider: 'whatsapp',
            senderId: 'two@c.us',
            emoji: '👍',
            observedAt,
        })
        const changed = applyProviderReactionEvent(second, {
            provider: 'whatsapp',
            senderId: 'one@c.us',
            emoji: '❤️',
            observedAt,
        })
        const removed = applyProviderReactionEvent(changed, {
            provider: 'whatsapp',
            senderId: 'two@c.us',
            emoji: '',
            observedAt,
        })

        expect(second.reactions).toEqual({ '👍': 2 })
        expect(changed.reactions).toEqual({ '👍': 1, '❤️': 1 })
        expect(removed.reactions).toEqual({ '❤️': 1 })
    })
})

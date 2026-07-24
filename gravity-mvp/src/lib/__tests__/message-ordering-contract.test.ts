import { describe, expect, it } from 'vitest'
import {
    compareMessagesChronologically,
    sortMessagesChronologically,
} from '@/app/messages/utils/message-order'

const base = {
    sentAt: '2026-07-25T10:00:00.000Z',
    createdAt: '2026-07-25T10:00:05.000Z',
}

describe('message chronological ordering', () => {
    it('places a late recovered first message before direct second and third messages', () => {
        const ordered = sortMessagesChronologically([
            { id: 'db-2', externalId: 'd3010000000000000002', sentAt: '2026-07-25T10:00:02.000Z' },
            { id: 'db-3', externalId: 'd3010000000000000003', sentAt: '2026-07-25T10:00:03.000Z' },
            { id: 'db-1', externalId: 'd3010000000000000001', sentAt: '2026-07-25T10:00:01.000Z' },
        ])

        expect(ordered.map(message => message.id)).toEqual(['db-1', 'db-2', 'db-3'])
    })

    it('uses provider external id before late database creation time for equal timestamps', () => {
        const ordered = sortMessagesChronologically([
            { ...base, id: 'db-2', externalId: 'd3010000000000000002', createdAt: '2026-07-25T10:00:01.000Z' },
            { ...base, id: 'db-1', externalId: 'd3010000000000000001', createdAt: '2026-07-25T10:00:10.000Z' },
            { ...base, id: 'db-3', externalId: 'd3010000000000000003', createdAt: '2026-07-25T10:00:02.000Z' },
        ])

        expect(ordered.map(message => message.id)).toEqual(['db-1', 'db-2', 'db-3'])
    })

    it('deduplicated replay and history overlap retain one deterministic row', () => {
        const replayed = [
            { ...base, id: 'db-2', externalId: 'd3010000000000000002' },
            { ...base, id: 'db-1', externalId: 'd3010000000000000001' },
            { ...base, id: 'db-2', externalId: 'd3010000000000000002' },
        ]
        const byId = [...new Map(replayed.map(message => [message.id, message])).values()]

        expect(sortMessagesChronologically(byId).map(message => message.id)).toEqual(['db-1', 'db-2'])
    })

    it('falls back to creation time and internal id when provider id is absent', () => {
        const sameSecond = [
            { ...base, id: 'db-b', createdAt: '2026-07-25T10:00:07.000Z' },
            { ...base, id: 'db-a', createdAt: '2026-07-25T10:00:06.000Z' },
            { ...base, id: 'db-c', createdAt: '2026-07-25T10:00:07.000Z' },
        ]

        expect(sameSecond.sort(compareMessagesChronologically).map(message => message.id))
            .toEqual(['db-a', 'db-b', 'db-c'])
    })
})

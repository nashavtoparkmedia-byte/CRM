// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
    INBOUND_NOTIFICATION_CREATED_WITHIN_MS_V1,
    INBOUND_NOTIFICATION_RECENCY_WINDOW_MS_V1,
    isInboundNotificationCandidateV1,
    qualifiesForInboundNotificationV1,
    type PersistedInboundMessageV1,
} from './inbound-notification-policy'

const NOW = new Date('2026-09-22T12:00:00.000Z')
const minutes = (n: number) => n * 60_000

function row(overrides: Partial<PersistedInboundMessageV1> = {}): PersistedInboundMessageV1 {
    return {
        id: 'msg_policy',
        chatId: 'chat_policy',
        direction: 'inbound',
        type: 'text',
        channel: 'telegram',
        metadata: {},
        sentAt: new Date(NOW.getTime() - minutes(1)),
        createdAt: new Date(NOW.getTime() - 1_000),
        ...overrides,
    }
}

describe('Mobile Push v1 product recency policy', () => {
    it('is a 15-minute window with a one-minute creation window', () => {
        expect(INBOUND_NOTIFICATION_RECENCY_WINDOW_MS_V1).toBe(minutes(15))
        expect(INBOUND_NOTIFICATION_CREATED_WITHIN_MS_V1).toBe(60_000)
    })

    it('qualifies a fresh inbound customer message on every notifying channel', () => {
        for (const channel of ['telegram', 'whatsapp', 'max', 'avito']) {
            expect(qualifiesForInboundNotificationV1(row({ channel }), NOW)).toBe(channel)
        }
    })

    it('never qualifies outbound, system or call-timeline rows, or the phone channel', () => {
        expect(qualifiesForInboundNotificationV1(row({ direction: 'outbound' }), NOW)).toBeNull()
        expect(qualifiesForInboundNotificationV1(row({ direction: 'system' }), NOW)).toBeNull()
        expect(qualifiesForInboundNotificationV1(row({ type: 'system' }), NOW)).toBeNull()
        expect(qualifiesForInboundNotificationV1(row({ type: 'call' }), NOW)).toBeNull()
        expect(qualifiesForInboundNotificationV1(row({ channel: 'phone', type: 'call' }), NOW)).toBeNull()
        expect(qualifiesForInboundNotificationV1(row({ channel: 'phone' }), NOW)).toBeNull()
        expect(qualifiesForInboundNotificationV1(row({ channel: null }), NOW)).toBeNull()
    })

    it('suppresses a known history or catch-up replay marker however recent', () => {
        expect(qualifiesForInboundNotificationV1(row({ channel: 'max', metadata: { source: 'history' } }), NOW)).toBeNull()
        expect(qualifiesForInboundNotificationV1(row({ channel: 'max', metadata: { source: 'catchup' } }), NOW)).toBeNull()
        // Live MAX sources are not replay markers.
        expect(qualifiesForInboundNotificationV1(row({ channel: 'max', metadata: { source: 'dom_fallback' } }), NOW)).toBe('max')
    })

    it('ACCEPTED TRADE-OFF: a recent imported message WITHOUT a replay marker notifies', () => {
        // An import path that stores no marker is indistinguishable from live
        // traffic here; a message sent a few minutes ago is treated as new.
        const recentImport = row({ channel: 'whatsapp', metadata: {}, sentAt: new Date(NOW.getTime() - minutes(5)) })
        expect(qualifiesForInboundNotificationV1(recentImport, NOW)).toBe('whatsapp')
    })

    it('ACCEPTED TRADE-OFF: a genuinely live message delivered more than 15 minutes late stays silent', () => {
        const lateLive = row({ sentAt: new Date(NOW.getTime() - minutes(16)), createdAt: new Date(NOW.getTime() - 1_000) })
        expect(qualifiesForInboundNotificationV1(lateLive, NOW)).toBeNull()
    })

    it('draws the window exactly at 15 minutes between provider time and persistence', () => {
        const createdAt = new Date(NOW.getTime() - 1_000)
        const atEdge = row({ createdAt, sentAt: new Date(createdAt.getTime() - minutes(15)) })
        const pastEdge = row({ createdAt, sentAt: new Date(createdAt.getTime() - minutes(15) - 1) })
        expect(qualifiesForInboundNotificationV1(atEdge, NOW)).toBe('telegram')
        expect(qualifiesForInboundNotificationV1(pastEdge, NOW)).toBeNull()
    })

    it('is a one-minute window after persistence, not a proof of creation by this call', () => {
        const persistedAgo = (ms: number) => row({ createdAt: new Date(NOW.getTime() - ms), sentAt: new Date(NOW.getTime() - ms - 1_000) })
        // Inside the minute a re-observed row qualifies again; the intent's
        // message-derived id is what keeps it to one intent.
        expect(qualifiesForInboundNotificationV1(persistedAgo(59_999), NOW)).toBe('telegram')
        expect(qualifiesForInboundNotificationV1(persistedAgo(60_000), NOW)).toBe('telegram')
        expect(qualifiesForInboundNotificationV1(persistedAgo(60_001), NOW)).toBeNull()
        expect(qualifiesForInboundNotificationV1(persistedAgo(minutes(2)), NOW)).toBeNull()
    })

    it('uses the same candidate rules before the write as after it', () => {
        expect(isInboundNotificationCandidateV1({ direction: 'inbound', type: 'text', channel: 'max', metadata: { source: 'history' } })).toBe(false)
        expect(isInboundNotificationCandidateV1({ direction: 'outbound', type: 'text', channel: 'max', metadata: null })).toBe(false)
        expect(isInboundNotificationCandidateV1({ direction: 'inbound', type: 'image', channel: 'avito', metadata: undefined })).toBe(true)
    })
})

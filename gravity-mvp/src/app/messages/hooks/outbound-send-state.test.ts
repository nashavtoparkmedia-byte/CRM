import { describe, expect, it } from 'vitest'
import { applySendAnswer, mergeCanonicalRow, outboundDeliveryState } from './outbound-send-state'
import type { Message } from './useMessages'

// S2 — the view shows the delivery state the server derives: from this
// device's own send answer until a canonical copy of the row arrives, then from
// the row's own status and evidence. A state from an earlier answer never
// outlives the row it described.

function row(fields: Partial<Message> = {}): Message {
    return {
        id: 'msg_1',
        direction: 'outbound',
        type: 'text',
        content: 'Привет',
        sentAt: '2026-10-04T10:00:00.000Z',
        status: 'sent',
        channel: 'telegram',
        clientMessageId: 'cmid-1',
        ...fields,
    }
}

const echoEvidence = { delivery: { v: 1, evidence: 'provider_echo', evidenceAt: '2026-10-04T10:00:05.000Z', source: 'echo' } }

describe('outboundDeliveryState', () => {
    it('has none while this device is sending, and none for inbound rows', () => {
        expect(outboundDeliveryState(row({ status: 'sending' }))).toBeNull()
        expect(outboundDeliveryState(row({ direction: 'inbound', status: 'delivered' }))).toBeNull()
    })

    it('derives a canonical row from its status and evidence, never from its provider id', () => {
        expect(outboundDeliveryState(row())).toBe('send_requested')
        expect(outboundDeliveryState(row({ externalId: 'tg-1' }))).toBe('send_requested')
        expect(outboundDeliveryState(row({ metadata: echoEvidence }))).toBe('provider_accepted')
        expect(outboundDeliveryState(row({ status: 'delivered' }))).toBe('delivered')
        expect(outboundDeliveryState(row({ status: 'failed', metadata: { deliveryOutcome: 'unknown' } }))).toBe('indeterminate')
    })
})

describe('the send answer', () => {
    it('carries the server-derived state onto this device\'s row', () => {
        const settled = applySendAnswer(row({ status: 'sending' }), { success: true, id: 'msg_1', status: 'sent', externalId: 'tg-1', deliveryState: 'provider_accepted' })
        expect(settled.status).toBe('sent')
        expect(outboundDeliveryState(settled)).toBe('provider_accepted')
    })

    it('ignores a state it does not know, and falls back to the row', () => {
        const settled = applySendAnswer(row({ status: 'sending' }), { success: true, status: 'sent', deliveryState: 'delivered-ish' })
        expect(settled.deliveryState).toBeUndefined()
        expect(outboundDeliveryState(settled)).toBe('send_requested')
    })

    it('an answer from an older server, without a state, derives from the answered status', () => {
        const settled = applySendAnswer(row({ status: 'sending' }), { success: true, status: 'delivered' })
        expect(outboundDeliveryState(settled)).toBe('delivered')
    })
})

describe('a canonical copy of the row', () => {
    it('replaces the answer\'s state with what the row now proves (late evidence)', () => {
        const answered = applySendAnswer(row({ status: 'sending' }), { success: true, status: 'sent', deliveryState: 'send_requested' })
        const promoted = mergeCanonicalRow(answered, row({ externalId: 'tg-1', metadata: echoEvidence }))
        expect(promoted.deliveryState).toBeUndefined()
        expect(outboundDeliveryState(promoted)).toBe('provider_accepted')
    })

    it('replaces the answer\'s state while the request is still in flight too', () => {
        const sending = { ...row({ status: 'sending' }), deliveryState: 'send_requested' as const }
        const merged = mergeCanonicalRow(sending, row({ metadata: echoEvidence }))
        expect(merged.status).toBe('sending')
        expect(merged.deliveryState).toBeUndefined()
    })

    it('an older snapshot keeps the newer state shown', () => {
        const read = applySendAnswer(row({ status: 'sending' }), { success: true, status: 'read', deliveryState: 'read' })
        const stale = mergeCanonicalRow(read, row({ status: 'sent' }))
        expect(stale.status).toBe('read')
        expect(outboundDeliveryState(stale)).toBe('read')
    })

    it('a partial update says nothing about delivery', () => {
        const accepted = applySendAnswer(row({ status: 'sending' }), { success: true, status: 'sent', deliveryState: 'provider_accepted' })
        const reacted = mergeCanonicalRow(accepted, { id: 'msg_1', metadata: { reactions: ['👍'] } } as unknown as Message)
        expect(outboundDeliveryState(reacted)).toBe('provider_accepted')
    })
})

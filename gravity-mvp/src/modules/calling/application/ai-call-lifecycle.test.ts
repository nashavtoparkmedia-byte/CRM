import { describe, expect, it } from 'vitest'
import {
    AiCallLifecycleConflictError,
    applyAiCallLifecycleEvent,
    createAiCallLifecycleJournal,
    metadataWithAiCallLifecycleJournal,
    readAiCallLifecycleJournal,
    type AiCallLifecycleEventInput,
    type AiCallLifecycleJournalV1,
} from './ai-call-lifecycle'

function bridge(
    kind: AiCallLifecycleEventInput['kind'],
    target: AiCallLifecycleEventInput['target'],
    sourceSequence: number,
    eventId = `${kind}-${sourceSequence}`,
): AiCallLifecycleEventInput {
    return { eventId, source: 'audio_bridge', sourceSequence, kind, target }
}

function apply(journal: AiCallLifecycleJournalV1, event: AiCallLifecycleEventInput) {
    return applyAiCallLifecycleEvent(journal, event).journal
}

describe('Calling canonical single-call lifecycle', () => {
    it('advances through the legal current vocabulary with monotonic revisions', () => {
        let journal = createAiCallLifecycleJournal('call-1')
        journal = apply(journal, bridge('greeting_started', 'greeting', 1))
        journal = apply(journal, bridge('conversation_started', 'active', 2))
        journal = apply(journal, bridge('transfer_started', 'transferring', 3))
        journal = apply(journal, {
            eventId: 'final-1', source: 'calling_finalization', sourceSequence: 1,
            kind: 'finalized', target: 'transferring',
        })
        expect(journal).toMatchObject({ state: 'transferring', revision: 4 })
        expect(journal.terminal).toMatchObject({ eventId: 'final-1', revision: 4 })
    })

    it('rejects an invalid transition without mutating the prior journal', () => {
        const journal = createAiCallLifecycleJournal('call-1')
        expect(() => applyAiCallLifecycleEvent(
            journal,
            bridge('transfer_started', 'transferring', 1),
        )).toThrowError(AiCallLifecycleConflictError)
        expect(journal).toMatchObject({ state: 'starting', revision: 0, receipts: [] })
    })

    it('replays an exact event and duplicate provider delivery idempotently', () => {
        const initial = createAiCallLifecycleJournal('call-1')
        const input = bridge('greeting_started', 'greeting', 1, 'provider-event-1')
        const first = applyAiCallLifecycleEvent(initial, input)
        const duplicate = applyAiCallLifecycleEvent(first.journal, structuredClone(input))
        expect(duplicate.kind).toBe('duplicate')
        expect(duplicate.journal).toEqual(first.journal)
        expect(duplicate.journal.revision).toBe(1)
    })

    it('rejects stale and out-of-order events deterministically and remembers the rejection', () => {
        let journal = createAiCallLifecycleJournal('call-1')
        journal = apply(journal, bridge('conversation_started', 'active', 2, 'active-first'))
        const stale = applyAiCallLifecycleEvent(journal, bridge('greeting_started', 'greeting', 1, 'late-greeting'))
        expect(stale.kind).toBe('stale')
        expect(stale.journal).toMatchObject({ state: 'active', revision: 1 })
        expect(applyAiCallLifecycleEvent(stale.journal, bridge(
            'greeting_started', 'greeting', 1, 'late-greeting',
        )).kind).toBe('stale')
    })

    it('fences terminal state and preserves first-valid-wins', () => {
        let journal = createAiCallLifecycleJournal('call-1')
        journal = apply(journal, bridge('conversation_started', 'active', 2))
        const terminal = bridge('call_ended', 'ended', 3, 'terminal-first')
        journal = apply(journal, terminal)
        expect(applyAiCallLifecycleEvent(journal, terminal).kind).toBe('duplicate')
        expect(() => applyAiCallLifecycleEvent(
            journal,
            bridge('provider_failed', 'failed', 4, 'terminal-second'),
        )).toThrowError(/terminal lifecycle cannot be overwritten/)
        expect(journal.state).toBe('ended')
    })

    it.each([
        ['call_cancelled', 'owner_cancelled'],
        ['call_timed_out', 'ring_timeout'],
        ['provider_failed', 'provider_unavailable'],
    ] as const)('has explicit %s terminal semantics (%s)', (kind, _reason) => {
        let journal = createAiCallLifecycleJournal(`call-${kind}`)
        journal = apply(journal, bridge('greeting_started', 'greeting', 1))
        journal = apply(journal, bridge(kind, 'failed', 2))
        expect(journal.state).toBe('failed')
        expect(journal.terminal?.kind).toBe(kind)
    })

    it('restores a durable journal after restart and keeps replay semantics', () => {
        const input = bridge('greeting_started', 'greeting', 1, 'restart-event')
        const applied = applyAiCallLifecycleEvent(createAiCallLifecycleJournal('call-1'), input)
        const restored = readAiCallLifecycleJournal(metadataWithAiCallLifecycleJournal({}, applied.journal))
        expect(restored).not.toBeNull()
        expect(applyAiCallLifecycleEvent(restored!, input).kind).toBe('duplicate')
        expect(restored?.revision).toBe(1)
    })

    it('fails closed when an identity is reused for a different normalized payload', () => {
        const first = applyAiCallLifecycleEvent(
            createAiCallLifecycleJournal('call-1'),
            bridge('greeting_started', 'greeting', 1, 'same-id'),
        )
        expect(() => applyAiCallLifecycleEvent(
            first.journal,
            bridge('conversation_started', 'active', 2, 'same-id'),
        )).toThrowError(/identity was reused/)
    })
})

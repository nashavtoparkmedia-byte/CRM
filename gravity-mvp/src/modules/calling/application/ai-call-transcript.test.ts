import { describe, expect, it } from 'vitest'
import {
    AI_CALL_TRANSCRIPT_MAX_CONTENT_CHARS,
    AiCallTranscriptConflictError,
    AiCallTranscriptInputError,
    createAiCallTranscriptJournal,
    createAiCallTranscriptOperation,
    reconcileAiCallTranscriptJournal,
    renderLegacyAiCallTranscriptProjection,
    type AiCallTranscriptJournalV1,
    type AiCallTranscriptMessageInput,
    type AiCallTranscriptPersistencePort,
} from './ai-call-transcript'

function message(ordinal: number, content = `message ${ordinal}`, overrides = {}): AiCallTranscriptMessageInput {
    return {
        messageId: `bridge-message-${ordinal}`,
        ordinal,
        role: ordinal % 2 ? 'user' : 'assistant',
        content,
        final: true,
        source: 'audio_bridge',
        ...overrides,
    }
}

class MemoryTranscriptPort implements AiCallTranscriptPersistencePort {
    journal: AiCallTranscriptJournalV1 = createAiCallTranscriptJournal('call-1')
    rows = new Map<string, { id: string; role: string; content: string }>()
    terminal = false

    async append(callId: string, input: AiCallTranscriptMessageInput) {
        if (callId !== 'call-1') return { kind: 'not_found' as const }
        const result = reconcileAiCallTranscriptJournal(callId, this.journal, input, this.terminal)
        if (result.kind === 'applied') {
            this.rows.set(result.receipt.rowId, {
                id: result.receipt.rowId,
                role: input.role,
                content: input.content,
            })
            this.journal = result.journal
        }
        return {
            ...result,
            callId,
            legacyTranscript: renderLegacyAiCallTranscriptProjection(result.journal, [...this.rows.values()]),
        }
    }
}

function harness(port = new MemoryTranscriptPort()) {
    return { port, append: createAiCallTranscriptOperation({ persistence: port }) }
}

describe('Calling canonical structured transcript', () => {
    it('persists the first canonical final message and derives the legacy projection', async () => {
        const h = harness()
        await expect(h.append('call-1', message(1, 'Здравствуйте'))).resolves.toMatchObject({
            kind: 'applied',
            legacyTranscript: '[Лид] Здравствуйте\n',
            receipt: { ordinal: 1, final: true },
        })
        expect(h.port.rows.size).toBe(1)
    })

    it('suppresses exact duplicate delivery and does not duplicate the legacy projection', async () => {
        const h = harness()
        const input = message(1, 'Да')
        await h.append('call-1', input)
        await expect(h.append('call-1', structuredClone(input))).resolves.toMatchObject({
            kind: 'duplicate', legacyTranscript: '[Лид] Да\n',
        })
        expect(h.port.rows.size).toBe(1)
        expect(h.port.journal.revision).toBe(1)
    })

    it('rejects the same stable identity with different content', async () => {
        const h = harness()
        await h.append('call-1', message(1, 'first'))
        await expect(h.append('call-1', message(1, 'changed')))
            .rejects.toMatchObject({ code: 'identity_collision' })
        expect(h.port.rows.size).toBe(1)
    })

    it('treats source provenance as part of a stable message fingerprint', async () => {
        const h = harness()
        await h.append('call-1', message(1, 'first'))
        await expect(h.append('call-1', message(1, 'first', { source: 'legacy_calling' })))
            .rejects.toMatchObject({ code: 'identity_collision' })
    })

    it('orders by deterministic ordinal and converges after out-of-order delivery', async () => {
        const h = harness()
        await expect(h.append('call-1', message(2, 'second'))).resolves.toMatchObject({
            legacyTranscript: '[AI] second\n',
        })
        await expect(h.append('call-1', message(1, 'first'))).resolves.toMatchObject({
            legacyTranscript: '[Лид] first\n[AI] second\n',
        })
        expect(h.port.journal).toMatchObject({ revision: 2, maxOrdinal: 2 })
    })

    it('fails closed when two final messages race for one ordinal', async () => {
        const h = harness()
        await h.append('call-1', message(1, 'first', { messageId: 'identity-a' }))
        await expect(h.append('call-1', message(1, 'second', { messageId: 'identity-b' })))
            .rejects.toMatchObject({ code: 'ordinal_collision' })
    })

    it('accepts an append-only final after terminal state with an explicit reconciliation receipt', async () => {
        const h = harness()
        h.port.terminal = true
        await expect(h.append('call-1', message(1))).resolves.toMatchObject({
            kind: 'applied', receipt: { acceptedAfterTerminal: true },
        })
    })

    it('preserves restart/replay semantics from the durable journal and rows', async () => {
        const firstRuntime = harness()
        const input = message(1, 'persisted')
        await firstRuntime.append('call-1', input)
        const restartedRuntime = harness(firstRuntime.port)
        await expect(restartedRuntime.append('call-1', input)).resolves.toMatchObject({ kind: 'duplicate' })
        expect(restartedRuntime.port.rows.size).toBe(1)
    })

    it.each([
        { ...message(1), final: false },
        { ...message(1), content: '' },
        { ...message(1), content: 'x'.repeat(AI_CALL_TRANSCRIPT_MAX_CONTENT_CHARS + 1) },
        { ...message(1), ordinal: 0 },
        { ...message(1), role: 'tool' },
    ])('rejects malformed, partial, or oversized message %#', async (input) => {
        const h = harness()
        await expect(h.append('call-1', input)).rejects.toBeInstanceOf(AiCallTranscriptInputError)
        expect(h.port.rows.size).toBe(0)
    })

    it('rejects a late partial deterministically after a final identity exists', async () => {
        const h = harness()
        await h.append('call-1', message(1, 'final'))
        await expect(h.append('call-1', { ...message(1, 'final'), final: false }))
            .rejects.toBeInstanceOf(AiCallTranscriptInputError)
        expect(h.port.rows.size).toBe(1)
    })

    it('uses deterministic row identity independent of arrival time', () => {
        const initial = createAiCallTranscriptJournal('call-1')
        const first = reconcileAiCallTranscriptJournal('call-1', initial, message(1), false)
        const replay = reconcileAiCallTranscriptJournal('call-1', initial, message(1), false)
        expect(first.receipt.rowId).toBe(replay.receipt.rowId)
        expect(first.receipt.rowId).toMatch(/^ai-call-message-v1-[0-9a-f]{64}$/)
    })

    it('exposes explicit conflict error classes for bounded callback mapping', () => {
        expect(new AiCallTranscriptConflictError('ordinal_collision', 'collision')).toMatchObject({
            code: 'ordinal_collision',
        })
    })
})

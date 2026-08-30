import { describe, expect, it } from 'vitest'
import {
    AI_CALL_TRANSCRIPT_MAX_CONTENT_CHARS,
    AiCallTranscriptConflictError,
    AiCallTranscriptInputError,
    createAiCallTranscriptJournal,
    createAiCallTranscriptOperation,
    materializeAiCallTranscriptSnapshot,
    parseLegacyAiCallTranscript,
    readAiCallTranscriptJournal,
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
        segmentRevision: 1,
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

    async snapshot(callId: string) {
        return callId === 'call-1'
            ? materializeAiCallTranscriptSnapshot(callId, this.journal, [...this.rows.values()])
            : null
    }
}

function harness(port = new MemoryTranscriptPort()) {
    return { port, append: createAiCallTranscriptOperation({ persistence: port }) }
}

describe('Calling canonical structured transcript', () => {
    it('persists a canonical segment and derives the legacy projection', async () => {
        const h = harness()
        await expect(h.append('call-1', message(1, 'Здравствуйте'))).resolves.toMatchObject({
            kind: 'applied',
            legacyTranscript: '[Лид] Здравствуйте\n',
            receipt: { ordinal: 1, segmentRevision: 1, final: true },
        })
        expect(h.port.rows.size).toBe(1)
    })

    it('suppresses exact duplicate delivery', async () => {
        const h = harness()
        const input = message(1, 'Да')
        await h.append('call-1', input)
        await expect(h.append('call-1', structuredClone(input))).resolves.toMatchObject({ kind: 'duplicate' })
        expect(h.port.rows.size).toBe(1)
        expect(h.port.journal.revision).toBe(1)
    })

    it('accepts a higher corrected segment revision and updates one stable row', async () => {
        const h = harness()
        await h.append('call-1', message(1, 'thre'))
        await expect(h.append('call-1', message(1, 'three', { segmentRevision: 2 }))).resolves.toMatchObject({
            kind: 'applied',
            legacyTranscript: '[Лид] three\n',
            receipt: { segmentRevision: 2, revision: 2 },
        })
        expect(h.port.rows.size).toBe(1)
        expect(h.port.journal.acceptedRevisions).toHaveLength(2)
    })

    it('classifies an accepted lower revision as stale without mutation', async () => {
        const h = harness()
        const first = message(1, 'interim', { final: false })
        await h.append('call-1', first)
        await h.append('call-1', message(1, 'final', { segmentRevision: 2, final: true }))
        await expect(h.append('call-1', first)).resolves.toMatchObject({
            kind: 'stale', receipt: { segmentRevision: 2 }, legacyTranscript: '[Лид] final\n',
        })
        expect(h.port.journal.revision).toBe(2)
    })

    it('rejects conflicting reuse of the same segment revision identity', async () => {
        const h = harness()
        await h.append('call-1', message(1, 'first'))
        await expect(h.append('call-1', message(1, 'changed')))
            .rejects.toMatchObject({ code: 'revision_collision' })
    })

    it('keeps segment identity fields immutable across corrections', async () => {
        const h = harness()
        await h.append('call-1', message(1, 'first'))
        await expect(h.append('call-1', message(2, 'changed', {
            messageId: 'bridge-message-1', segmentRevision: 2,
        }))).rejects.toMatchObject({ code: 'identity_collision' })
    })

    it('accepts interim-to-final progression but rejects final-to-interim regression', async () => {
        const h = harness()
        await h.append('call-1', message(1, 'hel', { final: false }))
        await expect(h.append('call-1', message(1, 'hello', { segmentRevision: 2, final: true })))
            .resolves.toMatchObject({ kind: 'applied', receipt: { final: true } })
        await expect(h.append('call-1', message(1, 'hello?', { segmentRevision: 3, final: false })))
            .rejects.toMatchObject({ code: 'final_regression' })
    })

    it('orders by deterministic ordinal and converges after out-of-order delivery', async () => {
        const h = harness()
        await h.append('call-1', message(2, 'second'))
        await expect(h.append('call-1', message(1, 'first'))).resolves.toMatchObject({
            legacyTranscript: '[Лид] first\n[AI] second\n',
        })
    })

    it('fails closed when two segment identities race for one ordinal', async () => {
        const h = harness()
        await h.append('call-1', message(1, 'first', { messageId: 'identity-a' }))
        await expect(h.append('call-1', message(1, 'second', { messageId: 'identity-b' })))
            .rejects.toMatchObject({ code: 'ordinal_collision' })
    })

    it('fences the terminal snapshot while allowing exact and stale replay', async () => {
        const h = harness()
        const first = message(1, 'draft', { final: false })
        const final = message(1, 'final', { segmentRevision: 2, final: true })
        await h.append('call-1', first)
        await h.append('call-1', final)
        h.port.terminal = true
        await expect(h.append('call-1', final)).resolves.toMatchObject({ kind: 'duplicate' })
        await expect(h.append('call-1', first)).resolves.toMatchObject({ kind: 'stale' })
        await expect(h.append('call-1', message(1, 'late correction', { segmentRevision: 3 })))
            .rejects.toMatchObject({ code: 'terminal_snapshot' })
        await expect(h.append('call-1', message(2, 'late segment')))
            .rejects.toMatchObject({ code: 'terminal_snapshot' })
    })

    it('reads labelled and plain legacy transcript without discarding content', () => {
        expect(parseLegacyAiCallTranscript('[Лид] Да\n[AI] Спасибо\n')).toMatchObject([
            { ordinal: 1, role: 'user', content: 'Да', final: true, source: 'legacy_calling' },
            { ordinal: 2, role: 'assistant', content: 'Спасибо', final: true, source: 'legacy_calling' },
        ])
        expect(parseLegacyAiCallTranscript('legacy whisper text')).toMatchObject([
            { ordinal: 1, role: 'user', content: 'legacy whisper text' },
        ])
        expect(parseLegacyAiCallTranscript('[Лид] Да\n[Лид] Да\n')).toHaveLength(2)
    })

    it('materializes a deterministic terminal snapshot from canonical rows', async () => {
        const h = harness()
        await h.append('call-1', message(2, 'second'))
        await h.append('call-1', message(1, 'first'))
        const snapshot = await h.port.snapshot('call-1')
        expect(snapshot).toMatchObject({ revision: 2, messages: [{ ordinal: 1 }, { ordinal: 2 }] })
        expect(snapshot?.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect((await h.port.snapshot('call-1'))?.sha256).toBe(snapshot?.sha256)
    })

    it('preserves restart/replay semantics from durable journal and rows', async () => {
        const firstRuntime = harness()
        const input = message(1, 'persisted')
        await firstRuntime.append('call-1', input)
        const restartedRuntime = harness(firstRuntime.port)
        await expect(restartedRuntime.append('call-1', input)).resolves.toMatchObject({ kind: 'duplicate' })
    })

    it('reads the original Stage 5 journal shape as segment revision one', () => {
        const reconciled = reconcileAiCallTranscriptJournal(
            'call-1', createAiCallTranscriptJournal('call-1'), message(1), false,
        ).journal
        const legacyShape = structuredClone(reconciled) as unknown as Record<string, unknown>
        delete legacyShape.acceptedRevisions
        const messages = legacyShape.messages as Array<Record<string, unknown>>
        delete messages[0].segmentRevision
        expect(readAiCallTranscriptJournal({ aiCallTranscriptV1: legacyShape })).toMatchObject({
            messages: [{ segmentRevision: 1 }],
            acceptedRevisions: [{ segmentRevision: 1 }],
        })
    })

    it.each([
        { ...message(1), content: '' },
        { ...message(1), content: 'x'.repeat(AI_CALL_TRANSCRIPT_MAX_CONTENT_CHARS + 1) },
        { ...message(1), ordinal: 0 },
        { ...message(1), segmentRevision: 0 },
        { ...message(1), role: 'tool' },
        { ...message(1), final: 'yes' },
    ])('rejects malformed or oversized message %#', async (input) => {
        const h = harness()
        await expect(h.append('call-1', input)).rejects.toBeInstanceOf(AiCallTranscriptInputError)
    })

    it('exposes explicit conflict error classes for bounded callback mapping', () => {
        expect(new AiCallTranscriptConflictError('ordinal_collision', 'collision')).toMatchObject({
            code: 'ordinal_collision',
        })
    })
})

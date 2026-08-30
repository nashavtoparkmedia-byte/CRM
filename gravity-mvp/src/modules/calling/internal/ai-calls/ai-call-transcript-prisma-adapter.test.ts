import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    createAiCallTranscriptJournal,
    reconcileAiCallTranscriptJournal,
} from '../../application/ai-call-transcript'

const mocks = vi.hoisted(() => {
    const tx = {
        $queryRaw: vi.fn(),
        call: { findUnique: vi.fn(), update: vi.fn() },
        aiCallMessage: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    }
    return {
        tx,
        transaction: vi.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
    }
})

vi.mock('@/lib/prisma', () => ({ prisma: { $transaction: mocks.transaction } }))

import { aiCallTranscriptPrismaPort } from './ai-call-transcript-prisma-adapter'

const MESSAGE = {
    messageId: 'audio-bridge-transcript:v1:fs-1:1',
    ordinal: 1,
    segmentRevision: 1,
    role: 'user' as const,
    content: 'Здравствуйте',
    final: true,
    source: 'audio_bridge' as const,
}

function call(overrides = {}) {
    return {
        id: 'call-1',
        isAi: true,
        startedAt: new Date('2026-08-29T10:00:00.000Z'),
        endedAt: null,
        aiSessionStatus: 'active',
        transcript: null,
        metadata: { kept: true },
        ...overrides,
    }
}

describe('Calling Prisma canonical transcript adapter', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.tx.$queryRaw.mockResolvedValue([{ id: 'call-1' }])
        mocks.tx.call.update.mockResolvedValue({})
        mocks.tx.aiCallMessage.create.mockResolvedValue({})
        mocks.tx.aiCallMessage.update.mockResolvedValue({})
    })

    it('locks Call, inserts one canonical row, and derives the legacy projection atomically', async () => {
        mocks.tx.call.findUnique.mockResolvedValue(call())
        mocks.tx.aiCallMessage.findMany
            .mockResolvedValueOnce([])
            .mockImplementationOnce(async () => [{
                id: mocks.tx.aiCallMessage.create.mock.calls[0][0].data.id,
                role: 'user',
                content: 'Здравствуйте',
            }])

        await expect(aiCallTranscriptPrismaPort.append('call-1', MESSAGE)).resolves.toMatchObject({
            kind: 'applied',
            legacyTranscript: '[Лид] Здравствуйте\n',
            receipt: { ordinal: 1, segmentRevision: 1, acceptedAfterTerminal: false },
        })
        expect(mocks.tx.aiCallMessage.create).toHaveBeenCalledTimes(1)
        expect(mocks.tx.call.update).toHaveBeenCalledWith({
            where: { id: 'call-1' },
            data: {
                transcript: '[Лид] Здравствуйте\n',
                metadata: expect.objectContaining({
                    kept: true,
                    aiCallTranscriptV1: expect.objectContaining({ revision: 1, maxOrdinal: 1 }),
                }),
            },
        })
        expect(mocks.tx.$queryRaw.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.tx.aiCallMessage.create.mock.invocationCallOrder[0])
    })

    it('updates the stable canonical row for a higher correction revision', async () => {
        const journal = reconcileAiCallTranscriptJournal(
            'call-1', createAiCallTranscriptJournal('call-1'), MESSAGE, false,
        ).journal
        const rowId = journal.messages[0].rowId
        mocks.tx.call.findUnique.mockResolvedValue(call({ metadata: { aiCallTranscriptV1: journal } }))
        mocks.tx.aiCallMessage.findMany.mockResolvedValue([{ id: rowId, role: 'user', content: 'Исправлено' }])

        await expect(aiCallTranscriptPrismaPort.append('call-1', {
            ...MESSAGE, segmentRevision: 2, content: 'Исправлено',
        })).resolves.toMatchObject({ kind: 'applied', receipt: { rowId, segmentRevision: 2 } })
        expect(mocks.tx.aiCallMessage.update).toHaveBeenCalledWith({
            where: { id: rowId }, data: { content: 'Исправлено' },
        })
        expect(mocks.tx.aiCallMessage.create).not.toHaveBeenCalled()
    })

    it('replays exact and stale receipts without another row mutation', async () => {
        const first = reconcileAiCallTranscriptJournal(
            'call-1', createAiCallTranscriptJournal('call-1'), MESSAGE, false,
        )
        const second = reconcileAiCallTranscriptJournal('call-1', first.journal, {
            ...MESSAGE, segmentRevision: 2, content: 'Исправлено',
        }, false)
        const rowId = second.receipt.rowId
        mocks.tx.call.findUnique.mockResolvedValue(call({ metadata: { aiCallTranscriptV1: second.journal } }))
        mocks.tx.aiCallMessage.findMany.mockResolvedValue([{ id: rowId, role: 'user', content: 'Исправлено' }])

        await expect(aiCallTranscriptPrismaPort.append('call-1', MESSAGE)).resolves.toMatchObject({ kind: 'stale' })
        expect(mocks.tx.aiCallMessage.create).not.toHaveBeenCalled()
        expect(mocks.tx.aiCallMessage.update).not.toHaveBeenCalled()
        expect(mocks.tx.call.update).not.toHaveBeenCalled()
    })

    it('fences new or corrected transcript content after terminal finalization', async () => {
        mocks.tx.call.findUnique.mockResolvedValue(call({ endedAt: new Date(), aiSessionStatus: 'ended' }))
        mocks.tx.aiCallMessage.findMany.mockResolvedValue([])
        await expect(aiCallTranscriptPrismaPort.append('call-1', MESSAGE))
            .rejects.toMatchObject({ code: 'terminal_snapshot' })
        expect(mocks.tx.aiCallMessage.create).not.toHaveBeenCalled()
    })

    it('lazily reads legacy Call.transcript, writes canonical rows, and returns a stable snapshot', async () => {
        mocks.tx.call.findUnique.mockResolvedValue(call({
            transcript: '[Лид] Да\n[AI] Спасибо\n',
            metadata: { kept: true },
        }))
        const stored: Array<{ id: string; role: string; content: string }> = []
        mocks.tx.aiCallMessage.create.mockImplementation(async ({ data }) => {
            stored.push({ id: data.id, role: data.role, content: data.content })
        })
        mocks.tx.aiCallMessage.findMany
            .mockResolvedValueOnce([])
            .mockImplementationOnce(async () => stored)

        await expect(aiCallTranscriptPrismaPort.snapshot('call-1')).resolves.toMatchObject({
            callId: 'call-1',
            revision: 2,
            messages: [
                { ordinal: 1, role: 'user', content: 'Да', source: 'legacy_calling' },
                { ordinal: 2, role: 'assistant', content: 'Спасибо', source: 'legacy_calling' },
            ],
        })
        expect(mocks.tx.aiCallMessage.create).toHaveBeenCalledTimes(2)
        expect(mocks.tx.call.update).toHaveBeenCalledWith({
            where: { id: 'call-1' },
            data: {
                transcript: '[Лид] Да\n[AI] Спасибо\n',
                metadata: expect.objectContaining({
                    kept: true,
                    aiCallTranscriptV1: expect.objectContaining({ revision: 2 }),
                }),
            },
        })
    })

    it('fails closed when a valid transcript journal is transplanted from another Call', async () => {
        mocks.tx.call.findUnique.mockResolvedValue(call({
            metadata: { aiCallTranscriptV1: createAiCallTranscriptJournal('call-other') },
        }))
        await expect(aiCallTranscriptPrismaPort.append('call-1', MESSAGE))
            .rejects.toMatchObject({ code: 'corrupt_journal' })
    })
})

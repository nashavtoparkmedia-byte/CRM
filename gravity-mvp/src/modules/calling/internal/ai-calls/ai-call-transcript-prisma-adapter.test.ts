import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    createAiCallTranscriptJournal,
    reconcileAiCallTranscriptJournal,
} from '../../application/ai-call-transcript'

const mocks = vi.hoisted(() => {
    const tx = {
        $queryRaw: vi.fn(),
        call: { findUnique: vi.fn(), update: vi.fn() },
        aiCallMessage: { findMany: vi.fn(), create: vi.fn() },
    }
    return {
        tx,
        transaction: vi.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
    }
})

vi.mock('@/lib/prisma', () => ({
    prisma: { $transaction: mocks.transaction },
}))

import { aiCallTranscriptPrismaPort } from './ai-call-transcript-prisma-adapter'

const MESSAGE = {
    messageId: 'audio-bridge-transcript:v1:fs-1:1',
    ordinal: 1,
    role: 'user' as const,
    content: 'Здравствуйте',
    final: true as const,
    source: 'audio_bridge' as const,
}

describe('Calling Prisma canonical transcript adapter', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.tx.$queryRaw.mockResolvedValue([{ id: 'call-1' }])
        mocks.tx.call.update.mockResolvedValue({})
        mocks.tx.aiCallMessage.create.mockResolvedValue({})
    })

    it('locks Call, inserts one canonical row, and derives the legacy projection atomically', async () => {
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', isAi: true, endedAt: null, aiSessionStatus: 'active', metadata: { kept: true },
        })
        mocks.tx.aiCallMessage.findMany
            .mockResolvedValueOnce([])
            .mockImplementationOnce(async () => [{
                id: mocks.tx.aiCallMessage.create.mock.calls[0][0].data.id,
                role: 'user',
                content: 'Здравствуйте',
            }])

        const result = await aiCallTranscriptPrismaPort.append('call-1', MESSAGE)
        expect(result).toMatchObject({
            kind: 'applied',
            legacyTranscript: '[Лид] Здравствуйте\n',
            receipt: { ordinal: 1, acceptedAfterTerminal: false },
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

    it('replays an exact receipt without another row or Call update', async () => {
        const journal = reconcileAiCallTranscriptJournal(
            'call-1', createAiCallTranscriptJournal('call-1'), MESSAGE, false,
        ).journal
        const rowId = journal.messages[0].rowId
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', isAi: true, endedAt: null, aiSessionStatus: 'active',
            metadata: { aiCallTranscriptV1: journal },
        })
        mocks.tx.aiCallMessage.findMany.mockResolvedValue([
            { id: rowId, role: 'user', content: 'Здравствуйте' },
        ])

        await expect(aiCallTranscriptPrismaPort.append('call-1', MESSAGE)).resolves.toMatchObject({
            kind: 'duplicate', legacyTranscript: '[Лид] Здравствуйте\n',
        })
        expect(mocks.tx.aiCallMessage.create).not.toHaveBeenCalled()
        expect(mocks.tx.call.update).not.toHaveBeenCalled()
    })

    it('marks a late final as an explicit post-terminal reconciliation', async () => {
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', isAi: true, endedAt: new Date(), aiSessionStatus: 'ended', metadata: {},
        })
        mocks.tx.aiCallMessage.findMany
            .mockResolvedValueOnce([])
            .mockImplementationOnce(async () => [{
                id: mocks.tx.aiCallMessage.create.mock.calls[0][0].data.id,
                role: 'user',
                content: 'Здравствуйте',
            }])
        await expect(aiCallTranscriptPrismaPort.append('call-1', MESSAGE)).resolves.toMatchObject({
            kind: 'applied', receipt: { acceptedAfterTerminal: true },
        })
    })

    it('fails closed when a valid transcript journal is transplanted from another Call', async () => {
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', isAi: true, endedAt: null, aiSessionStatus: 'active', transcript: null,
            metadata: { aiCallTranscriptV1: createAiCallTranscriptJournal('call-other') },
        })
        await expect(aiCallTranscriptPrismaPort.append('call-1', MESSAGE))
            .rejects.toMatchObject({ code: 'corrupt_journal' })
        expect(mocks.tx.aiCallMessage.create).not.toHaveBeenCalled()
        expect(mocks.tx.call.update).not.toHaveBeenCalled()
    })
})

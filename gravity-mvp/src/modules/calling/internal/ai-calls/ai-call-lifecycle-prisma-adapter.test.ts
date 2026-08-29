import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
    const tx = {
        $queryRawUnsafe: vi.fn(),
        call: { findUnique: vi.fn(), update: vi.fn() },
    }
    return {
        tx,
        transaction: vi.fn(async (operation: (value: typeof tx) => unknown) => operation(tx)),
    }
})

vi.mock('@/lib/prisma', () => ({
    prisma: { $transaction: mocks.transaction },
}))

import { aiCallLifecyclePrismaPort } from './ai-call-lifecycle-prisma-adapter'
import { createAiCallLifecycleJournal } from '../../application/ai-call-lifecycle'

const GREETING = {
    eventId: 'audio-bridge-lifecycle:v1:call-1:greeting_started',
    source: 'audio_bridge' as const,
    sourceSequence: 1,
    kind: 'greeting_started' as const,
    target: 'greeting' as const,
}

describe('Calling Prisma lifecycle adapter', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.tx.$queryRawUnsafe.mockResolvedValue([{ id: 'call-1' }])
        mocks.tx.call.update.mockResolvedValue({})
    })

    it('locks the canonical Call before applying and projecting a lifecycle event', async () => {
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', isAi: true, aiSessionStatus: 'starting', metadata: { kept: true },
        })
        await expect(aiCallLifecyclePrismaPort.apply('call-1', GREETING)).resolves.toMatchObject({
            kind: 'applied', callId: 'call-1', journal: { state: 'greeting', revision: 1 },
        })
        expect(mocks.tx.call.update).toHaveBeenCalledWith({
            where: { id: 'call-1' },
            data: {
                aiSessionStatus: 'greeting',
                metadata: expect.objectContaining({
                    kept: true,
                    aiCallLifecycleV1: expect.objectContaining({ state: 'greeting', revision: 1 }),
                }),
            },
        })
        expect(mocks.tx.$queryRawUnsafe).toHaveBeenCalledWith(
            'SELECT "id" FROM "Call" WHERE "id" = $1 FOR UPDATE',
            'call-1',
        )
        expect(mocks.tx.$queryRawUnsafe.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.tx.call.update.mock.invocationCallOrder[0])
    })

    it('replays an exact provider event without bumping updatedAt', async () => {
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', isAi: true, aiSessionStatus: 'starting', metadata: {},
        })
        const first = await aiCallLifecyclePrismaPort.apply('call-1', GREETING)
        mocks.tx.call.update.mockClear()
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', isAi: true, aiSessionStatus: 'greeting',
            metadata: { aiCallLifecycleV1: first.kind === 'not_found' ? null : first.journal },
        })
        await expect(aiCallLifecyclePrismaPort.apply('call-1', GREETING)).resolves.toMatchObject({ kind: 'duplicate' })
        expect(mocks.tx.call.update).not.toHaveBeenCalled()
    })

    it('records stale delivery without rolling the Call projection backward', async () => {
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', isAi: true, aiSessionStatus: 'starting', metadata: {},
        })
        const active = await aiCallLifecyclePrismaPort.apply('call-1', {
            eventId: 'active-first', source: 'audio_bridge', sourceSequence: 2,
            kind: 'conversation_started', target: 'active',
        })
        mocks.tx.call.update.mockClear()
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', isAi: true, aiSessionStatus: 'active',
            metadata: { aiCallLifecycleV1: active.kind === 'not_found' ? null : active.journal },
        })
        await expect(aiCallLifecyclePrismaPort.apply('call-1', GREETING)).resolves.toMatchObject({
            kind: 'stale', journal: { state: 'active', revision: 1 },
        })
        expect(mocks.tx.call.update).toHaveBeenCalledWith({
            where: { id: 'call-1' },
            data: { metadata: expect.any(Object) },
        })
    })

    it('adopts a legacy same-state Call into the durable journal idempotently', async () => {
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', isAi: true, aiSessionStatus: 'greeting', metadata: {},
        })
        await expect(aiCallLifecyclePrismaPort.apply('call-1', GREETING)).resolves.toMatchObject({
            kind: 'applied', journal: { state: 'greeting', revision: 1 },
        })
    })

    it('classifies a lower-sequence legacy callback as stale from the current projection', async () => {
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', isAi: true, aiSessionStatus: 'active', metadata: {},
        })
        await expect(aiCallLifecyclePrismaPort.apply('call-1', GREETING)).resolves.toMatchObject({
            kind: 'stale', journal: { state: 'active', revision: 0 },
        })
        expect(mocks.tx.call.update).toHaveBeenCalledWith({
            where: { id: 'call-1' },
            data: { metadata: expect.any(Object) },
        })
    })

    it('fails closed when a valid journal is transplanted from another Call', async () => {
        mocks.tx.call.findUnique.mockResolvedValue({
            id: 'call-1', isAi: true, aiSessionStatus: 'starting',
            metadata: { aiCallLifecycleV1: createAiCallLifecycleJournal('call-other') },
        })
        await expect(aiCallLifecyclePrismaPort.apply('call-1', GREETING))
            .rejects.toMatchObject({ code: 'identity_collision' })
        expect(mocks.tx.call.update).not.toHaveBeenCalled()
    })
})

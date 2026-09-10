import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    callCreate: vi.fn(),
    callFindUnique: vi.fn(),
    callUpdate: vi.fn(),
    queryRaw: vi.fn(),
    transaction: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        call: {
            create: mocks.callCreate,
            findUnique: mocks.callFindUnique,
        },
        $transaction: mocks.transaction,
    },
}))

import { controlledRealAiCallPrismaPort } from './controlled-real-ai-call-prisma-adapter'

const storageClaim = {
    callId: 'controlled_live_call_1',
    fsUuid: '11111111-1111-4111-a111-111111111111',
    requestFingerprint: 'f'.repeat(64),
    input: {
        actorId: 'operator-1',
        requestId: 'operator-proof-0001',
        scenarioId: 'scenario-1',
        scenarioName: 'Qualification',
        toNumber: '+79990000000',
        fromNumber: '+79991112233',
        driverId: null,
        contactId: 'contact-1',
        providers: {
            telephony: 'freeswitch' as const,
            trunk: 'megafon' as const,
            llm: 'openai' as const,
            stt: 'openai' as const,
            tts: 'openai' as const,
        },
    },
}

function storedCall(metadata: unknown = {
    controlledRealCallV1: { requestFingerprint: storageClaim.requestFingerprint },
}) {
    return {
        id: storageClaim.callId,
        fsUuid: storageClaim.fsUuid,
        managerId: storageClaim.input.actorId,
        toNumber: storageClaim.input.toNumber,
        aiScenarioId: storageClaim.input.scenarioId,
        isAi: true,
        isSimulation: false,
        status: 'ringing',
        aiSessionStatus: 'starting',
        metadata,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.transaction.mockImplementation(async (operation) => operation({
        $queryRaw: mocks.queryRaw,
        call: {
            findUnique: mocks.callFindUnique,
            update: mocks.callUpdate,
        },
    }))
})

describe('controlled real AI-call Prisma admission', () => {
    it('atomically converts a concurrent P2002 claim into an idempotent duplicate', async () => {
        const raced = storedCall()
        mocks.callFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(raced)
        mocks.callCreate.mockRejectedValue({ code: 'P2002' })

        await expect(controlledRealAiCallPrismaPort.claim(storageClaim)).resolves.toEqual({
            kind: 'duplicate',
            call: raced,
        })
        expect(mocks.callCreate).toHaveBeenCalledTimes(1)
    })

    it('fails closed when the deterministic identity is already bound to another payload', async () => {
        mocks.callFindUnique.mockResolvedValue(storedCall({
            controlledRealCallV1: { requestFingerprint: '0'.repeat(64) },
        }))
        await expect(controlledRealAiCallPrismaPort.claim(storageClaim)).resolves.toEqual({
            kind: 'conflict',
        })
        expect(mocks.callCreate).not.toHaveBeenCalled()
    })

    it('merges durable accepted observability without overwriting lifecycle metadata', async () => {
        mocks.callFindUnique.mockResolvedValue({
            metadata: {
                aiCallLifecycleV1: { version: 1 },
                controlledRealCallV1: {
                    requestFingerprint: storageClaim.requestFingerprint,
                    dispatchState: 'claimed',
                },
            },
        })

        await controlledRealAiCallPrismaPort.recordDispatch({
            callId: storageClaim.callId,
            requestFingerprint: storageClaim.requestFingerprint,
            state: 'accepted',
            providerReference: storageClaim.fsUuid,
            recordedAt: new Date('2026-09-03T00:00:00.000Z'),
        })

        expect(mocks.callUpdate).toHaveBeenCalledWith({
            where: { id: storageClaim.callId },
            data: {
                metadata: {
                    aiCallLifecycleV1: { version: 1 },
                    controlledRealCallV1: expect.objectContaining({
                        dispatchState: 'accepted',
                        dispatchRecordedAt: '2026-09-03T00:00:00.000Z',
                        providerReference: storageClaim.fsUuid,
                    }),
                },
            },
        })
    })

    it('records an ambiguous outcome without projecting a terminal call state', async () => {
        mocks.callFindUnique.mockResolvedValue({
            metadata: {
                controlledRealCallV1: {
                    requestFingerprint: storageClaim.requestFingerprint,
                    dispatchState: 'claimed',
                },
            },
        })

        await controlledRealAiCallPrismaPort.recordDispatch({
            callId: storageClaim.callId,
            requestFingerprint: storageClaim.requestFingerprint,
            state: 'outcome_unknown',
            failureCode: 'PROVIDER_OUTCOME_UNKNOWN',
            recordedAt: new Date('2026-09-03T00:00:00.000Z'),
        })

        const update = mocks.callUpdate.mock.calls[0][0]
        expect(update.data).not.toHaveProperty('endedAt')
        expect(update.data).not.toHaveProperty('hangupCause')
        expect(update.data.metadata.controlledRealCallV1).toMatchObject({
            dispatchState: 'outcome_unknown',
            failureCode: 'PROVIDER_OUTCOME_UNKNOWN',
        })
    })
})

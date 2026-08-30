import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1,
    makeAiCallFinalizationFollowUpRequestedEventV1,
} from '../../../../contracts/calling/v1'

const mocks = vi.hoisted(() => ({
    enqueueTranscribe: vi.fn(),
    recoverFollowUp: vi.fn(),
}))

vi.mock('@/lib/queue/queues', () => ({ enqueueTranscribe: mocks.enqueueTranscribe }))
vi.mock('../../application/ai-call-finalization-recovery-runtime', () => ({
    recoverAiCallFinalizationFollowUpByIdentity: mocks.recoverFollowUp,
}))

import { callingOutboxPublishersV1 } from './outbox-consumers'

describe('Calling outbox finalization recovery consumer', () => {
    const event = makeAiCallFinalizationFollowUpRequestedEventV1({
        callId: 'call-1',
        finalizationId: 'ai-call-finalization:v1:call-1',
        finalizationFingerprint: 'a'.repeat(64),
        occurredAt: '2026-08-29T10:00:00.000Z',
    })

    beforeEach(() => vi.clearAllMocks())

    it('validates the durable event and recovers exactly its aggregate identity', async () => {
        await callingOutboxPublishersV1[AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1](event)
        expect(mocks.recoverFollowUp).toHaveBeenCalledWith('call-1', 'a'.repeat(64))
        expect(mocks.enqueueTranscribe).not.toHaveBeenCalled()
    })

    it('fails closed before recovery when the payload identity is changed', async () => {
        await expect(callingOutboxPublishersV1[AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1]({
            ...event,
            data: { ...event.data, callId: 'call-other' },
        })).rejects.toMatchObject({ code: 'INVALID_AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT' })
        expect(mocks.recoverFollowUp).not.toHaveBeenCalled()
    })

    it('propagates retryable recovery failure to the bounded outbox retry lane', async () => {
        mocks.recoverFollowUp.mockRejectedValueOnce(new Error('AI_CALL_FINALIZATION_FOLLOW_UP_RETRYABLE:retry_wait'))
        await expect(callingOutboxPublishersV1[AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1](event))
            .rejects.toThrow('AI_CALL_FINALIZATION_FOLLOW_UP_RETRYABLE')
    })
})

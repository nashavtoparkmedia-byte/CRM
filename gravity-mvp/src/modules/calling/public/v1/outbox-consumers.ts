import {
    AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1,
    RECORDING_READY_EVENT_V1,
    parseAiCallFinalizationFollowUpRequestedEventV1,
    parseRecordingReadyEventV1,
} from '../../../../contracts/calling/v1'
import type { OutboxPublisherRegistryV1 } from '../../../../infrastructure/outbox/v1'
import { enqueueTranscribe } from '@/lib/queue/queues'
import { recoverAiCallFinalizationFollowUpByIdentity } from '../../application/ai-call-finalization-recovery-runtime'

export const callingOutboxPublishersV1: OutboxPublisherRegistryV1 = {
    [RECORDING_READY_EVENT_V1]: async (payload) => {
        const event = parseRecordingReadyEventV1(payload)
        // BullMQ jobId is `transcribe-${callId}`, so redelivery is idempotent.
        await enqueueTranscribe(event.data.callId)
    },
    [AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1]: async (payload) => {
        const event = parseAiCallFinalizationFollowUpRequestedEventV1(payload)
        await recoverAiCallFinalizationFollowUpByIdentity(
            event.data.callId,
            event.data.finalizationFingerprint,
        )
    },
}

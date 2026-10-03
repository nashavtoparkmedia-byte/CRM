import {
    AI_CALL_FINALIZATION_FOLLOW_UP_REQUESTED_EVENT_V1,
    CALL_ALERT_DELIVERY_REQUESTED_EVENT_V1,
    CALL_ALERT_REQUESTED_EVENT_V1,
    RECORDING_READY_EVENT_V1,
    parseAiCallFinalizationFollowUpRequestedEventV1,
    parseRecordingReadyEventV1,
} from '../../../../contracts/calling/v1'
import type { OutboxPublisherRegistryV1 } from '../../../../infrastructure/outbox/v1'
import { enqueueTranscribe } from '@/lib/queue/queues'
import { recoverAiCallFinalizationFollowUpByIdentity } from '../../application/ai-call-finalization-recovery-runtime'
import {
    handleCallAlertDeliveryRequestedV1,
    handleCallAlertRequestedV1,
} from '../../application/call-alert-operations'

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
    // Two steps on purpose: fanning out and delivering retry independently, so a
    // single unreachable device neither holds up the rest nor re-sends to the
    // devices that already succeeded.
    [CALL_ALERT_REQUESTED_EVENT_V1]: async (payload) => {
        await handleCallAlertRequestedV1(payload)
    },
    [CALL_ALERT_DELIVERY_REQUESTED_EVENT_V1]: async (payload) => {
        await handleCallAlertDeliveryRequestedV1(payload)
    },
}

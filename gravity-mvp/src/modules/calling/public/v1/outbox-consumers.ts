import {
    RECORDING_READY_EVENT_V1,
    parseRecordingReadyEventV1,
} from '../../../../contracts/calling/v1'
import type { OutboxPublisherRegistryV1 } from '../../../../infrastructure/outbox/v1'
import { enqueueTranscribe } from '@/lib/queue/queues'

export const callingOutboxPublishersV1: OutboxPublisherRegistryV1 = {
    [RECORDING_READY_EVENT_V1]: async (payload) => {
        const event = parseRecordingReadyEventV1(payload)
        // BullMQ jobId is `transcribe-${callId}`, so redelivery is idempotent.
        await enqueueTranscribe(event.data.callId)
    },
}

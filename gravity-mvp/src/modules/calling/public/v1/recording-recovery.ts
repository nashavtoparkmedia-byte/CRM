import { syncCallToChat } from '@/lib/freeswitch/EslClient'
import { processRecording } from '@/lib/freeswitch/recordingProcessor'
import { enqueueTranscribe } from '@/lib/queue/queues'

export interface CompletedCallTimelineBackfillV1 {
  id: string
  contactId: string | null
  driverId: string | null
  direction: string
  fromNumber: string | null
  toNumber: string | null
  status: string
  durationSec: number | null
  hangupCause: string | null
  startedAt: Date
  endedAt: Date | null
}
export interface RecordingRecoveryV1 {
  callId: string
  fsUuid: string
  recordingFile: string
}

/** Backfill exactly one completed call into the protected Messaging timeline. */
export async function backfillCompletedCallTimelineV1(call: CompletedCallTimelineBackfillV1): Promise<void> {
  await syncCallToChat(call)
}

/** Re-run the existing WAV-to-storage recovery pipeline for exactly one call. */
export async function recoverCallRecordingV1(input: RecordingRecoveryV1): Promise<void> {
  await processRecording(input)
}

/** Enqueue transcription for exactly one already-stored call recording. */
export async function enqueueRecoveredCallTranscriptionV1(callId: string): Promise<void> {
  await enqueueTranscribe(callId)
}

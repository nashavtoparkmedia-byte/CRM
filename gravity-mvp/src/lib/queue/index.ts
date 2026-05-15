/**
 * Single entrypoint for the BullMQ-based call processing pipeline.
 *
 * Pipeline (Stage 4):
 *   recordingProcessor.processRecording (post-hangup)
 *     └── enqueueTranscribe(callId)            [call-transcribe queue]
 *           └── Whisper API → Call.transcript
 *                 └── Stage 4b will enqueue analyze → Claude analysis
 *
 * Workers are started from instrumentation.ts on server boot.
 */

export { enqueueTranscribe, enqueueAnalyze, closeQueues } from '@/lib/queue/queues'
export { startTranscribeWorker, stopTranscribeWorker } from '@/lib/queue/transcribeWorker'
export { closeRedisConnection } from '@/lib/queue/connection'

import { startTranscribeWorker } from '@/lib/queue/transcribeWorker'
import { opsLog } from '@/lib/opsLog'

let started = false

// Stub: extended in Stage 4b to also start the analyze worker.
export async function stopAnalyzeWorker(): Promise<void> { /* no-op in 4a */ }

/**
 * Idempotent: safe to call multiple times. Logs and swallows individual
 * worker startup failures — we don't want a missing API key to brick the
 * whole CRM, and the missing-key error will surface on the first real job
 * attempt anyway.
 */
export function startCallProcessingWorkers(): void {
    if (started) return
    started = true

    try {
        startTranscribeWorker()
    } catch (err: any) {
        opsLog('error', 'transcribe_worker_start_failed', { operation: 'queue', error: err.message })
    }
}

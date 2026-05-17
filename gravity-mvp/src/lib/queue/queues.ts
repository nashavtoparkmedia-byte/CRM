/**
 * Queue declarations + thin producer helpers.
 *
 * Two queues:
 *  - call-transcribe   — Whisper transcription of MP3 recordings
 *  - call-analyze      — Claude evaluation of the transcript
 *
 * Both run as separate workers (see transcribeWorker.ts / analyzeWorker.ts) so
 * a slow Claude call doesn't block Whisper jobs and vice versa.
 *
 * Job IDs are derived from callId — BullMQ then dedupes natively. This matters
 * because CHANNEL_HANGUP_COMPLETE can fire twice on FreeSWITCH crashes /
 * unusual hangup races, and we don't want to pay for the same Whisper call
 * twice.
 */

import { Queue, type JobsOptions } from 'bullmq'
import { getRedisConnection } from '@/lib/queue/connection'

export const TRANSCRIBE_QUEUE = 'call-transcribe'
export const ANALYZE_QUEUE = 'call-analyze'

export interface TranscribeJobData {
    callId: string
}

export interface AnalyzeJobData {
    callId: string
}

let transcribeQueue: Queue<TranscribeJobData> | null = null
let analyzeQueue: Queue<AnalyzeJobData> | null = null

function getTranscribeQueue(): Queue<TranscribeJobData> {
    if (!transcribeQueue) {
        transcribeQueue = new Queue<TranscribeJobData>(TRANSCRIBE_QUEUE, {
            connection: getRedisConnection(),
            defaultJobOptions: defaultJobOptions(),
        })
    }
    return transcribeQueue
}

function getAnalyzeQueue(): Queue<AnalyzeJobData> {
    if (!analyzeQueue) {
        analyzeQueue = new Queue<AnalyzeJobData>(ANALYZE_QUEUE, {
            connection: getRedisConnection(),
            defaultJobOptions: defaultJobOptions(),
        })
    }
    return analyzeQueue
}

function defaultJobOptions(): JobsOptions {
    return {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        // Keep done jobs for an hour for inspection in BullMQ UIs; auto-clean later.
        removeOnComplete: { age: 3600, count: 200 },
        // Failed jobs kept for a day so we can see what blew up.
        removeOnFail: { age: 24 * 3600 },
    }
}

/**
 * Enqueue Whisper transcription for a Call. Idempotent on callId — repeated
 * enqueue calls with the same callId reuse the same job id and BullMQ ignores
 * the duplicate.
 *
 * jobId uses `-` not `:` as the separator — BullMQ 5+ rejects colons in
 * custom job ids (`Custom Id cannot contain :`), and we hit that as a
 * silent enqueue failure on every call until this got fixed.
 */
export async function enqueueTranscribe(callId: string): Promise<void> {
    await getTranscribeQueue().add(
        'transcribe',
        { callId },
        { jobId: `transcribe-${callId}` },
    )
}

/**
 * Enqueue Claude AI analysis for a Call. Caller is expected to ensure
 * Call.transcript is populated; the worker will skip if it isn't.
 *
 * jobId uses `-` not `:` for the same reason as enqueueTranscribe above.
 */
export async function enqueueAnalyze(callId: string): Promise<void> {
    await getAnalyzeQueue().add(
        'analyze',
        { callId },
        { jobId: `analyze-${callId}` },
    )
}

export async function closeQueues(): Promise<void> {
    await transcribeQueue?.close().catch(() => {})
    await analyzeQueue?.close().catch(() => {})
    transcribeQueue = null
    analyzeQueue = null
}

/**
 * Whisper transcription worker.
 *
 * Reads Call.recordingPath, pulls the MP3 from S3, runs it through the OpenAI
 * Whisper API, writes the resulting transcript back to Call.transcript, then
 * enqueues the AI analysis stage. Pushes a `updated` event to subscribers of
 * the call SSE stream so the open call detail tab refreshes immediately.
 *
 * Errors during transcription are non-fatal for the call — BullMQ will retry
 * up to N attempts (see queues.ts). If all attempts fail the job sits in the
 * failed set for a day for manual inspection; the call row stays without a
 * transcript but is otherwise intact (recording playback still works).
 */

import { Worker, type Job } from 'bullmq'
import { File } from 'node:buffer'
import { prisma } from '@/lib/prisma'
import { opsLog } from '@/lib/opsLog'
import { getRedisConnection } from '@/lib/queue/connection'
import { TRANSCRIBE_QUEUE, type TranscribeJobData, enqueueAnalyze } from '@/lib/queue/queues'
import { getObject } from '@/lib/storage/minio'
import { broadcastCall } from '@/lib/callStreamBus'
import { getOpenAI } from '@/lib/openaiClient'

const WHISPER_MODEL = process.env.OPENAI_WHISPER_MODEL ?? 'whisper-1'
const TRANSCRIBE_LANGUAGE = process.env.OPENAI_WHISPER_LANGUAGE ?? 'ru'

let worker: Worker<TranscribeJobData> | null = null

export function startTranscribeWorker(): void {
    if (worker) return

    worker = new Worker<TranscribeJobData>(
        TRANSCRIBE_QUEUE,
        async (job: Job<TranscribeJobData>) => {
            const { callId } = job.data
            await processOne(callId)
        },
        {
            connection: getRedisConnection(),
            concurrency: Number(process.env.TRANSCRIBE_CONCURRENCY ?? 2),
        },
    )

    worker.on('failed', (job, err) => {
        opsLog('error', 'transcribe_job_failed', {
            operation: 'transcribe',
            callId: job?.data.callId,
            attemptsMade: job?.attemptsMade,
            error: err.message,
        })
    })

    worker.on('completed', (job) => {
        opsLog('info', 'transcribe_job_completed', {
            operation: 'transcribe',
            callId: job.data.callId,
        })
    })

    opsLog('info', 'transcribe_worker_started', { operation: 'queue' })
}

async function processOne(callId: string): Promise<void> {
    const call = await prisma.call.findUnique({
        where: { id: callId },
        select: { id: true, recordingPath: true, transcript: true },
    })

    if (!call) {
        opsLog('warn', 'transcribe_call_missing', { operation: 'transcribe', callId })
        return
    }
    if (!call.recordingPath) {
        opsLog('warn', 'transcribe_no_recording', { operation: 'transcribe', callId })
        return
    }
    if (call.transcript && call.transcript.length > 0) {
        // Idempotency — re-running the job for the same call should not
        // double-charge Whisper. Skip straight to the analyze stage.
        opsLog('info', 'transcribe_skip_already_done', { operation: 'transcribe', callId })
        await enqueueAnalyze(callId)
        return
    }

    const mp3 = await getObject(call.recordingPath)
    // Whisper SDK accepts File / Blob — we wrap the Buffer to keep types happy
    // and to give the upload a recognisable filename (extension matters for MIME).
    const file = new File([new Uint8Array(mp3)], `${callId}.mp3`, { type: 'audio/mpeg' })

    const startedAt = Date.now()
    const response = await getOpenAI().audio.transcriptions.create({
        file: file as any,  // OpenAI types want browser File but Node 20+ has a compatible one
        model: WHISPER_MODEL,
        language: TRANSCRIBE_LANGUAGE,
        response_format: 'text',
    })

    // response_format:'text' returns a plain string; with json it's an object
    const transcript = typeof response === 'string' ? response.trim() : (response as any).text?.trim() ?? ''

    if (!transcript) {
        opsLog('warn', 'transcribe_empty_result', { operation: 'transcribe', callId })
        // Empty transcript is not a retryable failure — just bail.
        return
    }

    await prisma.call.update({
        where: { id: callId },
        data: { transcript },
    })

    opsLog('info', 'transcribe_saved', {
        operation: 'transcribe',
        callId,
        chars: transcript.length,
        latencyMs: Date.now() - startedAt,
    })

    broadcastCall({
        type: 'updated',
        data: { callId, transcript },
    })

    // Hand off to AI analysis — separate queue so a slow Claude call doesn't
    // back up the Whisper pipeline.
    await enqueueAnalyze(callId)
}

export async function stopTranscribeWorker(): Promise<void> {
    if (!worker) return
    await worker.close()
    worker = null
}

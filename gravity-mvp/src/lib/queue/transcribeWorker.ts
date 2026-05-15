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
import { ProxyAgent, fetch as undiciFetch, FormData as UndiciFormData } from 'undici'

// OpenAI Whisper. Two non-obvious requirements live here:
//
// 1) HTTPS_PROXY=http://127.0.0.1:10809 must be set on the Node process
//    so it exits via our xray VPN node, not the system "geoip:ru→direct"
//    route. /v1/audio/transcriptions geo-blocks our public IP otherwise.
//
// 2) The audio endpoint rejects the OpenAI SDK's outgoing fingerprint
//    (User-Agent: OpenAI/JS + x-stainless-* headers and some additional
//    body framing we couldn't fully strip via SDK config) from our VPN
//    exit IP with 403 unsupported_country, while a plain curl-equivalent
//    POST with the SAME key + SAME IP + SAME body passes cleanly. So we
//    bypass the SDK entirely for audio and use undici fetch with a
//    ProxyAgent + curl-like headers. analyzeWorker.ts does the same for
//    chat completions for the same reason.
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? 'whisper-1'
const TRANSCRIBE_LANGUAGE = process.env.WHISPER_LANGUAGE ?? 'ru'

function getProxyDispatcher() {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    return proxy ? new ProxyAgent(proxy) : undefined
}

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

/**
 * Run one transcription synchronously. Exposed so admin / recovery tools can
 * trigger the Whisper pipeline without going through the BullMQ queue —
 * useful when the worker isn't running (e.g. a one-shot CLI script) or when
 * we already have the callId in hand and don't want enqueue latency.
 */
export async function processTranscribe(callId: string): Promise<void> {
    return processOne(callId)
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

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set')

    const fd = new UndiciFormData()
    fd.set('file', new Blob([new Uint8Array(mp3)], { type: 'audio/mpeg' }), `${callId}.mp3`)
    fd.set('model', WHISPER_MODEL)
    fd.set('language', TRANSCRIBE_LANGUAGE)
    fd.set('response_format', 'text')

    const startedAt = Date.now()
    const r = await undiciFetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        dispatcher: getProxyDispatcher(),
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'User-Agent': 'curl/8.10.1',
            Accept: '*/*',
        },
        body: fd,
    })
    if (!r.ok) {
        const errBody = await r.text().catch(() => '')
        throw new Error(`whisper_http_${r.status}: ${errBody.slice(0, 500)}`)
    }
    const transcript = (await r.text()).trim()

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

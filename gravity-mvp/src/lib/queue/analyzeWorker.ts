/**
 * OpenAI-powered call analysis worker.
 *
 * Reads Call.transcript and asks GPT-4o (or whatever model the admin picked
 * in TelephonyAiConfig) to evaluate the manager along five criteria. The
 * structured JSON response is persisted to Call.aiScore / aiSummary /
 * aiAnalysis, then a SSE `updated` event is broadcast so the open call
 * detail tab refreshes immediately.
 *
 * Output shape is guaranteed by `response_format: { type: 'json_object' }` —
 * OpenAI's JSON-mode prevents the model from emitting prose around the
 * payload, so the parser only has to validate the field types.
 *
 * Prompt caching: OpenAI caches the prefix of any prompt ≥1024 tokens for
 * ~5 minutes automatically. Our default system prompt is well over that
 * threshold and stays stable between calls — `usage.prompt_tokens_details.
 * cached_tokens` in the response tells us how many of the input tokens
 * came from cache, which we log for cost visibility.
 */

import { Worker, type Job } from 'bullmq'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { opsLog } from '@/lib/opsLog'
import { getRedisConnection } from '@/lib/queue/connection'
import { ANALYZE_QUEUE, type AnalyzeJobData } from '@/lib/queue/queues'
import { broadcastCall } from '@/lib/callStreamBus'
import { getOpenAI } from '@/lib/openaiClient'
import { getTelephonyAiConfig } from '@/lib/aiCallAnalysis/config'
import { parseAnalysisResponse, averageScore } from '@/lib/aiCallAnalysis/prompt'

const MAX_OUTPUT_TOKENS = 1024

let worker: Worker<AnalyzeJobData> | null = null

export function startAnalyzeWorker(): void {
    if (worker) return

    worker = new Worker<AnalyzeJobData>(
        ANALYZE_QUEUE,
        async (job: Job<AnalyzeJobData>) => {
            const { callId } = job.data
            await processOne(callId)
        },
        {
            connection: getRedisConnection(),
            concurrency: Number(process.env.ANALYZE_CONCURRENCY ?? 2),
        },
    )

    worker.on('failed', (job, err) => {
        opsLog('error', 'analyze_job_failed', {
            operation: 'analyze',
            callId: job?.data.callId,
            attemptsMade: job?.attemptsMade,
            error: err.message,
        })
    })

    worker.on('completed', (job) => {
        opsLog('info', 'analyze_job_completed', {
            operation: 'analyze',
            callId: job.data.callId,
        })
    })

    opsLog('info', 'analyze_worker_started', { operation: 'queue' })
}

async function processOne(callId: string): Promise<void> {
    const call = await prisma.call.findUnique({
        where: { id: callId },
        select: { id: true, transcript: true, aiAnalysis: true },
    })
    if (!call) {
        opsLog('warn', 'analyze_call_missing', { operation: 'analyze', callId })
        return
    }
    if (!call.transcript || call.transcript.trim().length === 0) {
        opsLog('warn', 'analyze_no_transcript', { operation: 'analyze', callId })
        return
    }
    if (call.aiAnalysis) {
        // Skip if already analyzed. Avoids double-billing on accidental re-enqueue.
        opsLog('info', 'analyze_skip_already_done', { operation: 'analyze', callId })
        return
    }

    const config = await getTelephonyAiConfig()
    if (!config.enabled) {
        opsLog('info', 'analyze_disabled', { operation: 'analyze', callId })
        return
    }

    const startedAt = Date.now()
    const completion = await getOpenAI().chat.completions.create({
        model: config.model,
        // JSON-mode — the model is required to emit a valid JSON object, so
        // we don't have to defensively unfence ```json blocks etc.
        response_format: { type: 'json_object' },
        // Low temperature: we want repeatable rubric scoring, not creativity.
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
            { role: 'system', content: config.systemPrompt },
            {
                role: 'user',
                content: `Расшифровка звонка:\n\n${call.transcript}`,
            },
        ],
    })

    const content = completion.choices[0]?.message?.content
    if (!content) {
        throw new Error('analyze: openai returned empty content')
    }

    const parsed = parseAnalysisResponse(JSON.parse(content))
    const aiScore = averageScore(parsed.scores)

    await prisma.call.update({
        where: { id: callId },
        data: {
            aiScore,
            aiSummary: parsed.summary,
            aiAnalysis: parsed as unknown as Prisma.InputJsonValue,
        },
    })

    // Cache hit visibility: prompt_tokens_details.cached_tokens is part of
    // the new usage payload OpenAI rolled out alongside automatic prompt
    // caching. Older SDK versions may not type this field, hence the cast.
    const usage = completion.usage as
        | (typeof completion.usage & { prompt_tokens_details?: { cached_tokens?: number } })
        | undefined

    opsLog('info', 'analyze_saved', {
        operation: 'analyze',
        callId,
        aiScore,
        model: config.model,
        latencyMs: Date.now() - startedAt,
        promptTokens: usage?.prompt_tokens ?? 0,
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
    })

    broadcastCall({
        type: 'updated',
        data: {
            callId,
            aiScore,
            aiSummary: parsed.summary,
            aiAnalysis: parsed,
        },
    })
}

export async function stopAnalyzeWorker(): Promise<void> {
    if (!worker) return
    await worker.close()
    worker = null
}

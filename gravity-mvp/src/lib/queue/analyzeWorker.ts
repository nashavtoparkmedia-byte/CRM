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
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { prisma } from '@/lib/prisma'
import { opsLog } from '@/lib/opsLog'
import { getRedisConnection } from '@/lib/queue/connection'
import { ANALYZE_QUEUE, type AnalyzeJobData } from '@/lib/queue/queues'
import { broadcastCall } from '@/lib/callStreamBus'
import { getTelephonyAiConfig } from '@/lib/aiCallAnalysis/config'
import { parseAnalysisResponse, averageScore, buildSystemPrompt } from '@/lib/aiCallAnalysis/prompt'

// Why a hand-rolled fetch instead of the OpenAI SDK: the SDK's outgoing
// fingerprint (User-Agent OpenAI/JS + x-stainless-* headers) is enough for
// OpenAI's edge to flip our VPN exit IP into 403 unsupported_country, while
// a curl-equivalent POST with the SAME key + SAME IP + SAME body sails
// through. Mirrors the same workaround in transcribeWorker.ts.
function getProxyDispatcher() {
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    return proxy ? new ProxyAgent(proxy) : undefined
}

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

/**
 * Run one AI analysis synchronously. Exposed so admin / recovery tools can
 * trigger the analysis pipeline without going through BullMQ. The function
 * itself is idempotent — re-running on a Call that already has aiAnalysis
 * is a no-op (avoids double-billing).
 */
export async function processAnalyze(callId: string): Promise<void> {
    return processOne(callId)
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

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set')

    // Dynamic system prompt assembled from config.criteria + option lists.
    // Falls back to config.systemPrompt only if no active criteria — gives
    // admins a "raw textarea" escape hatch while keeping the structured UI
    // as the primary path.
    const hasCriteria = Array.isArray(config.criteria) && config.criteria.some((c: any) => c.isActive)
    const systemPrompt = hasCriteria ? buildSystemPrompt(config) : config.systemPrompt

    const startedAt = Date.now()
    const r = await undiciFetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        dispatcher: getProxyDispatcher(),
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': 'curl/8.10.1',
            Accept: '*/*',
        },
        body: JSON.stringify({
            model: config.model,
            // JSON-mode — the model is required to emit a valid JSON object,
            // so we don't have to defensively unfence ```json blocks etc.
            response_format: { type: 'json_object' },
            // Low temperature: we want repeatable rubric scoring, not creativity.
            temperature: 0,
            max_tokens: MAX_OUTPUT_TOKENS,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Расшифровка звонка:\n\n${call.transcript}` },
            ],
        }),
    })
    if (!r.ok) {
        const errBody = await r.text().catch(() => '')
        throw new Error(`chat_http_${r.status}: ${errBody.slice(0, 500)}`)
    }
    const completion = await r.json() as any

    const content = completion.choices?.[0]?.message?.content
    if (!content) {
        throw new Error('analyze: openai returned empty content')
    }

    const parsed = parseAnalysisResponse(JSON.parse(content), config)
    const aiScore = averageScore(parsed.scores, config)

    // Persist new categorical fields (outcome/sentiment/nextAction). They live
    // as new Call columns after the v2 schema migration; we cast through any
    // because the generated Prisma client on Windows can lag behind schema.
    await (prisma as any).call.update({
        where: { id: callId },
        data: {
            aiScore,
            aiSummary: parsed.summary,
            aiAnalysis: parsed as unknown as Prisma.InputJsonValue,
            outcome: parsed.outcome,
            clientSentiment: parsed.client_sentiment,
            nextActionType: parsed.next_action_type,
            nextActionDue: parsed.next_action_due ? new Date(parsed.next_action_due) : null,
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

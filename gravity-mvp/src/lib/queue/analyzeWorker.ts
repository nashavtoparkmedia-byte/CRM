/**
 * OpenAI-powered call analysis worker.
 *
 * Reads Call.transcript and asks GPT-4o (or whatever model the admin picked
 * in TelephonyAiConfig) to evaluate the manager along the admin-editable
 * rubric criteria. The structured JSON response is persisted to
 * Call.aiScore / aiSummary / aiAnalysis / outcome / clientSentiment /
 * nextActionType / nextActionDue, then a SSE `updated` event is broadcast
 * so the open call detail tab refreshes immediately.
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
 *
 * Two analysis paths:
 *   - analyzeManagerCall — `isAi=false` rows (human inbound/outbound). Uses
 *     the rubric-based prompt + writes Call.aiScore + categorical outcome
 *     columns.
 *   - analyzeAiCall      — `isAi=true` rows where the bridge finalized
 *     WITHOUT an `end_call` tool result (lead hung up mid-call). Extracts
 *     a QualificationResult via the separate qualifyPrompt and writes
 *     Call.aiOutcome=dropped_mid_call (PR #57 fallback path).
 */

import { Worker, type Job } from 'bullmq'
import type { Prisma } from '@prisma/client'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { prisma } from '@/lib/prisma'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { getRedisConnection } from '@/lib/queue/connection'
import { ANALYZE_QUEUE, type AnalyzeJobData } from '@/lib/queue/queues'
import { broadcastCall } from '@/modules/calling/internal/call-stream'
import { createCallingOpenAiChatCompletionV1 } from '@/modules/calling/public/v1/openai-chat-completion'
import { getTelephonyAiConfig } from '@/lib/aiCallAnalysis/config'
import { parseAnalysisResponse, averageScore, buildSystemPrompt } from '@/lib/aiCallAnalysis/prompt'
import {
    DEFAULT_QUALIFY_PROMPT,
    parseQualifyResponse,
    type QualificationResult,
} from '@/lib/aiCallAnalysis/qualifyPrompt'

// Why a hand-rolled fetch instead of the OpenAI SDK for the manager path:
// the SDK's outgoing fingerprint (User-Agent OpenAI/JS + x-stainless-*
// headers) is enough for OpenAI's edge to flip our VPN exit IP into 403
// unsupported_country, while a curl-equivalent POST with the SAME key +
// SAME IP + SAME body sails through. Mirrors the same workaround in
// transcribeWorker.ts.
//
// The AI-call fallback path (analyzeAiCall) still uses the SDK — it
// fires rarely (only when the bridge finalize didn't reach end_call),
// and migrating it to undici is a follow-up. If the geofence ever
// trips on that path, swap createCallingOpenAiChatCompletionV1() for
// undiciFetch + the same
// custom headers.
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
    const call = await prisma.call.findFirst({
        where: { id: callId, isSimulation: false },
        // `isAi` decides which prompt/parser we use — manager evaluation
        // (rubric) for human inbound/outbound calls, qualification
        // extraction (QualificationResult shape) for AI-bot outbound calls.
        select: { id: true, transcript: true, aiAnalysis: true, isAi: true },
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
        // Covers both paths: AI-call where bridge already wrote aiAnalysis via
        // the `end_call` tool, and manager-call where the previous job finished.
        opsLog('info', 'analyze_skip_already_done', { operation: 'analyze', callId })
        return
    }

    const config = await getTelephonyAiConfig()
    if (!config.enabled) {
        opsLog('info', 'analyze_disabled', { operation: 'analyze', callId })
        return
    }

    if (call.isAi) {
        await analyzeAiCall(callId, call.transcript, config.model)
    } else {
        await analyzeManagerCall(callId, call.transcript, config)
    }
}

/**
 * Manager evaluation path: scores a human manager's call against the
 * admin-editable rubric (config.criteria + outcome/sentiment/nextAction
 * option lists) and writes:
 *   - Call.aiScore           (weighted average of criteria scores)
 *   - Call.aiSummary         (Claude's 1-line summary)
 *   - Call.aiAnalysis        (full structured JSON)
 *   - Call.outcome           (from config.outcomeOptions, key only)
 *   - Call.clientSentiment   (from config.sentimentOptions)
 *   - Call.nextActionType    (from config.nextActionOptions)
 *   - Call.nextActionDue
 */
async function analyzeManagerCall(
    callId: string,
    transcript: string,
    config: Awaited<ReturnType<typeof getTelephonyAiConfig>>,
): Promise<void> {
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
                { role: 'user', content: `Расшифровка звонка:\n\n${transcript}` },
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

    logUsage(callId, 'analyze_saved', config.model, startedAt, completion.usage, { aiScore })

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

/**
 * AI-call fallback path: extracts a QualificationResult from the live
 * transcript the bridge already streamed in. Runs when the bridge
 * finalized without an `end_call` tool result (lead hung up early).
 *
 * NOT a manager evaluation — we score lead readiness, not the AI's
 * performance. aiScore stays null (the 1–10 rubric makes no sense here);
 * aiSummary gets the lead_summary so list views still have a 1-line
 * preview.
 */
async function analyzeAiCall(callId: string, transcript: string, model: string): Promise<void> {
    const startedAt = Date.now()
    const completion = await createCallingOpenAiChatCompletionV1({
        model,
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
            { role: 'system', content: DEFAULT_QUALIFY_PROMPT },
            { role: 'user', content: `Расшифровка звонка AI-ассистента с лидом:\n\n${transcript}` },
        ],
    })

    const content = completion.choices[0]?.message?.content
    if (!content) {
        throw new Error('analyze (ai-call): openai returned empty content')
    }

    const parsed: QualificationResult = parseQualifyResponse(JSON.parse(content))

    // PR #57 — Structured Outcome Layer (fallback path).
    //
    // The analyzeWorker only fires when the bridge finalized WITHOUT an
    // end_call tool result — i.e. the lead hung up mid-call (transcript
    // exists, otherwise the enqueue is skipped in finalize route.ts).
    // So the CALL EVENT is unambiguously a drop, regardless of what the
    // post-hoc analyzer says about lead quality.
    //
    // Two distinct dimensions:
    //   - aiOutcome           — what the call EVENT was (here: drop)
    //   - qualificationScore  — how good the LEAD was (analyzer can opine)
    //
    // We set aiOutcome=dropped_mid_call deterministically. We do NOT
    // touch qualificationScore here — the post-hoc analyzer doesn't
    // currently emit a numeric score, and back-fitting one from the
    // parsed.qualification_status free-text would be guessing.
    // leadDataStructured stays null in this path: parsed.answers has a
    // fixed analyzer schema (has_license / experience_years / ...) that
    // is intentionally different from the scenario-canonical schema,
    // and mapping between them is out of scope for this PR.
    await (prisma as any).call.update({
        where: { id: callId },
        data: {
            // aiScore intentionally NOT set — the 1–10 rubric is for human
            // manager evaluation, not for lead qualification.
            aiSummary: parsed.lead_summary,
            aiAnalysis: parsed as unknown as Prisma.InputJsonValue,
            aiOutcome: 'dropped_mid_call' as any,
            aiOutcomeReason: 'user_hangup_recovered_by_post_hoc_analysis',
        } as any,
    })

    logUsage(callId, 'analyze_ai_call_saved', model, startedAt, completion.usage, {
        qualification: parsed.qualification_status,
    })

    broadcastCall({
        type: 'updated',
        data: { callId, aiSummary: parsed.lead_summary, aiAnalysis: parsed },
    })
}

/**
 * Shared OpenAI usage-logging helper. cached_tokens visibility helps verify
 * that the long stable system prompt is hitting OpenAI's automatic prompt
 * cache (~50% input-token discount when warm).
 */
function logUsage(
    callId: string,
    event: string,
    model: string,
    startedAt: number,
    usageIn: unknown,
    extra: Record<string, unknown>,
): void {
    const usage = usageIn as
        | { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
        | undefined

    opsLog('info', event, {
        operation: 'analyze',
        callId,
        model,
        latencyMs: Date.now() - startedAt,
        promptTokens: usage?.prompt_tokens ?? 0,
        cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        ...extra,
    })
}

export async function stopAnalyzeWorker(): Promise<void> {
    if (!worker) return
    await worker.close()
    worker = null
}

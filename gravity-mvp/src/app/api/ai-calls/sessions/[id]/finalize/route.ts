/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client types
   for AI-call models may not be regenerated on every dev box. */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { opsLog } from '@/lib/opsLog'
import { enqueueAnalyze } from '@/lib/queue/queues'
// PR #57: Structured Outcome Layer. Pure-CommonJS helpers (no TS loader
// needed; node:test can require them directly).
import {
    computeOutcome,
    tagWithValidationIssues,
    normalizeQualificationScore,
} from '@/lib/ai-call/outcome-mapper'
import { validateLeadData } from '@/lib/ai-call/scenario-schema'
// PR #59: Conversation Intelligence v1. Best-effort event persistence —
// helper NEVER throws to the caller; insert failures are logged and
// the finalize response still returns success.
import { _createPersistEvents } from '@/lib/ai-call/event-emitter'

// Bind once at module init. Same DI pattern as other AI-call helpers.
const persistEvents = _createPersistEvents(prisma as any)

/**
 * Race a promise against a deadline. If the inner promise doesn't settle
 * within `ms`, throw a clearly-tagged timeout error so the caller can log
 * the stage that hung without leaking the inner unsettled promise.
 *
 * Used because BullMQ Queue.add (and similar Redis-dependent calls) holds
 * commands on the offline queue with `maxRetriesPerRequest: null`. When
 * Redis is unreachable that queue never drains and the await blocks the
 * whole HTTP request indefinitely — which manifested as «finalize >5 s,
 * aiSessionStatus=failed» (Task #5).
 */
function withTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
    let to: NodeJS.Timeout | undefined
    const timer = new Promise<never>((_, reject) => {
        to = setTimeout(() => reject(new Error(`timeout_${tag}_after_${ms}ms`)), ms)
    })
    return Promise.race([p, timer]).finally(() => { if (to) clearTimeout(to) }) as Promise<T>
}

export const dynamic = 'force-dynamic'

/**
 * POST /api/ai-calls/sessions/[id]/finalize
 *
 * Bridge writes the final dialog result back to CRM after the LLM emits
 * end_call (or transfer_to_manager, or the WS just closes). Mirrors the
 * structure of /api/ai-calls/mock so the CRM-side rendering code on
 * /calls/<id> doesn't have to branch on mock-vs-live.
 *
 *  body: {
 *    callUuid: string                          — for diagnostics
 *    reason: 'completed' | 'transferred' | 'closed' | string
 *    result?: {
 *      qualification_status: 'qualified' | 'not_qualified' | 'unclear'
 *      lead_summary: string
 *      reason: string
 *      qualification_score?: number             — 0–100, PR #57 (optional)
 *      manager_task?: { should_create: boolean, summary?: string, priority?: 'high'|'normal'|'low' }
 *      transfer_reason?: string
 *      lead_data?: Record<string, string>
 *    }
 *    leadData?: Record<string, string>
 *    transcript?: Array<{ role: 'user'|'assistant', content: string }>
 *    realUserUtterances?: number               — PR #57: real STT-derived
 *      user turns ONLY (excludes bridge-synthesized silence wake-ups).
 *      Drives outcome classification. Older bridges that don't send this
 *      field fall back to counting user-role items in `transcript`.
 *    events?: Array<{ type, seq, occurredAt?, payload? }>
 *                                              — PR #59: Conversation
 *      Intelligence v1 timeline. Bridge accumulates in-memory, ships in
 *      finalize body. CRM bulk-inserts via best-effort helper — insert
 *      failure does NOT fail the finalize.
 *  }
 *
 * Side-effects:
 *   - Call.aiSessionStatus → 'ended' | 'failed' | 'transferring'
 *   - Call.aiAnalysis ← result JSON (incl. lead_data merged in) — UNCHANGED
 *     and preserved verbatim for forensics / debugging.
 *   - Call.aiSummary ← result.lead_summary
 *   - Call.aiTransferReason ← result.transfer_reason
 *   - Call.endedAt, durationSec — computed
 *   - PR #57 — Structured Outcome Layer:
 *     - Call.aiOutcome           ← deterministic enum from outcome-mapper
 *     - Call.aiOutcomeReason     ← machine-friendly slug + optional
 *                                  ';validation_issues=N' suffix
 *     - Call.qualificationScore  ← LLM-provided 0–100 score (clamped)
 *     - Call.leadDataStructured  ← scenario-schema-validated canonical fields
 *   - Optionally creates a Task for the manager when
 *     result.manager_task.should_create is true.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params
    if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })

    let body: any
    try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

    // Include the scenario row so the outcome-mapper validation step can
    // see `outcomeSchema` without a second roundtrip. The relation may
    // be null for legacy / hand-created Call rows; the validator
    // gracefully passes through when schema is absent.
    const call = await (prisma as any).call.findUnique({
        where: { id },
        include: { aiScenario: { select: { outcomeSchema: true } } },
    })
    if (!call) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    const reason: string = body.reason ?? 'closed'
    const result = body.result ?? null
    const leadData = body.leadData ?? null

    const endedAt = new Date()
    const startedAt = call.startedAt ?? endedAt
    const durationSec = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000))

    // Map reason → AiCallSessionStatus enum
    const sessionStatus =
        reason === 'completed' ? 'ended' :
        reason === 'transferred' ? 'transferring' :
        reason === 'closed' ? 'ended' :
        'failed'

    const aiAnalysisPayload = result
        ? {
            qualification_status: result.qualification_status ?? 'unclear',
            lead_summary: result.lead_summary ?? null,
            reason: result.reason ?? null,
            // qualification_score persists through aiAnalysis too — keeps
            // raw / structured paths in lockstep for forensics.
            qualification_score: result.qualification_score ?? null,
            transfer_reason: result.transfer_reason ?? null,
            manager_task: result.manager_task ?? { should_create: false },
            lead_data: leadData ?? result.lead_data ?? {},
        }
        : null

    let createdTask: { id: string; title: string } | null = null
    if (
        aiAnalysisPayload &&
        aiAnalysisPayload.manager_task?.should_create &&
        call.driverId
    ) {
        const task = await prisma.task.create({
            data: {
                driverId: call.driverId,
                contactId: call.contactId,
                source: 'auto',
                type: 'ai_call_followup',
                title: `AI-звонок: ${aiAnalysisPayload.lead_summary ?? 'результат разговора'}`,
                description: aiAnalysisPayload.manager_task.summary ?? aiAnalysisPayload.reason ?? null,
                priority: (
                    aiAnalysisPayload.manager_task.priority === 'high' ? 'high' :
                    aiAnalysisPayload.manager_task.priority === 'low' ? 'low' :
                    'medium'
                ) as any,
                status: 'todo',
                createdBy: call.managerId ?? null,
                metadata: {
                    aiCallId: call.id,
                    qualification: aiAnalysisPayload.qualification_status,
                } as any,
            },
        })
        createdTask = { id: task.id, title: task.title }
        ;(aiAnalysisPayload as any).created_task_id = task.id
    }

    // ── PR #57: Structured Outcome Layer ─────────────────────────────────
    // Compute the deterministic AiOutcome enum from finalize inputs.
    // `realUserUtterances` comes from the bridge (counter of real STT
    // finals only, excluding synthetic wake-ups). For older bridges that
    // pre-date this field, fall back to counting user-role transcript
    // items — the synthetic-wake-up false positive is tolerable because
    // it only affects edge cases (full-silence calls); the new field
    // closes that hole exactly.
    const realUserUtterances: number = typeof body.realUserUtterances === 'number'
        ? body.realUserUtterances
        : Array.isArray(body.transcript)
            ? body.transcript.filter((t: any) => t?.role === 'user').length
            : 0

    const { outcome: aiOutcome, reason: outcomeReasonSlug } = computeOutcome({
        aiAnalysis: aiAnalysisPayload,
        reason,
        sessionStatus,
        realUserUtterances,
    })

    // Validate lead_data against the scenario's outcomeSchema (if any).
    // Extra LLM keys are silently dropped; mismatches surface as `issues`
    // for the opsLog/runbook signal but DO NOT block finalize.
    const scenarioOutcomeSchema = (call as any).aiScenario?.outcomeSchema ?? null
    const { data: leadDataStructured, issues: validationIssues } = validateLeadData(
        aiAnalysisPayload?.lead_data ?? null,
        scenarioOutcomeSchema,
    )

    const aiOutcomeReason = tagWithValidationIssues(outcomeReasonSlug, validationIssues.length)
    const qualificationScore = normalizeQualificationScore(aiAnalysisPayload?.qualification_score)

    await (prisma as any).call.update({
        where: { id },
        data: {
            status: 'completed',
            endedAt,
            durationSec,
            hangupCause: 'NORMAL_CLEARING',
            aiSessionStatus: sessionStatus,
            // Raw aiAnalysis preserved verbatim for forensics / debugging
            // — never overwritten with structured fields.
            aiAnalysis: aiAnalysisPayload as any,
            aiSummary: aiAnalysisPayload?.lead_summary ?? null,
            aiTransferReason: result?.transfer_reason ?? null,
            // Structured outcome columns — queryable, A/B-testable.
            aiOutcome,
            aiOutcomeReason,
            qualificationScore,
            leadDataStructured: leadDataStructured as any,
        } as any,
    })

    if (validationIssues.length > 0) {
        // Runbook signal: scenario authors / PMs see this and know to
        // either tighten the scenario prompt or relax the schema.
        // Capped at 10 issues to keep logs bounded; the count above is
        // the source of truth for SQL queries (the `;validation_issues=N`
        // suffix on aiOutcomeReason).
        opsLog('warn', 'ai_outcome_schema_validation_issues', {
            callId: id,
            scenarioId: call.aiScenarioId ?? null,
            issuesCount: validationIssues.length,
            issues: validationIssues.slice(0, 10),
        })
    }

    opsLog('info', 'ai_call_finalized', {
        callId: id,
        reason,
        sessionStatus,
        qualification: aiAnalysisPayload?.qualification_status,
        // PR #57 — structured fields for grep-friendly ops visibility.
        aiOutcome,
        aiOutcomeReason,
        qualificationScore,
        structuredLeadDataFieldsCount: Object.keys(leadDataStructured).length,
        validationIssuesCount: validationIssues.length,
        taskId: createdTask?.id,
    })

    // ── PR #59: Conversation Intelligence v1 — persist timeline events ─
    //
    // Architectural contract (architect-mandated):
    //   - append-only insert
    //   - best-effort emission
    //   - no transaction coupling — Call.update committed FIRST above
    //   - event layer must NOT break the call → helper never throws
    //
    // We synthesise one CRM-side event (`call_completed`) here with the
    // canonical outcome already computed, then bulk-insert it together
    // with the bridge-supplied events. The helper handles validation,
    // unknown types, and DB failures internally.
    const bridgeEvents: any[] = Array.isArray(body.events) ? body.events : []
    // `completed_via` is a small enum that captures HOW the call ended.
    // Maps the bridge's `reason` + the computed outcome into one of:
    //   bridge_error              — sessionStatus=failed (STT/LLM/bridge crash)
    //   llm_transfer_to_manager   — LLM invoked the transfer tool
    //   llm_end_call              — LLM reached end_call with a verdict
    //   silence_timeout           — silence-strike 2 ended the call
    //                               (outcome=dropped_no_input)
    //   ws_close                  — WS closed without LLM tool — lead hung up
    const completedVia: string = (() => {
        if (sessionStatus === 'failed') return 'bridge_error'
        if (reason === 'transferred') return 'llm_transfer_to_manager'
        if (reason === 'completed') {
            // Silence-timeout path: bridge synthesises an end_call(unclear)
            // and lands here with reason=completed but no real engagement.
            if (aiOutcome === 'dropped_no_input') return 'silence_timeout'
            return 'llm_end_call'
        }
        return 'ws_close'
    })()
    const maxBridgeSeq: number = bridgeEvents.reduce(
        (m: number, e: any) => (typeof e?.seq === 'number' && e.seq > m ? e.seq : m),
        0,
    )
    const eventsResult = await persistEvents({
        events: [
            ...bridgeEvents,
            {
                type: 'call_completed',
                seq: maxBridgeSeq + 1,
                occurredAt: endedAt.toISOString(),
                payload: {
                    outcome: aiOutcome,
                    hangup_cause: 'NORMAL_CLEARING',
                    total_ms: durationSec * 1000,
                    completed_via: completedVia,
                    validation_issues_count: validationIssues.length,
                },
            },
        ],
        callId: id,
        opsLog,
    })

    // Single ops-line summary of event persistence. The HTTP response
    // does NOT expose this — events are an observability sidecar; the
    // log is the source of truth for operators verifying emission.
    opsLog('info', 'ai_call_events_persisted', {
        callId: id,
        inserted: eventsResult.inserted,
        skipped: eventsResult.skipped,
        errored: eventsResult.errored,
        issues: eventsResult.issues.slice(0, 5),
    })

    // Fallback analysis path. The bridge only sends `result` when the LLM
    // reached the `end_call` tool (or transferred). If the lead hung up
    // before that — common on the very first turn — we still have a
    // bridge-streamed transcript but no aiAnalysis. Enqueue a job so the
    // analyzeWorker (isAi branch) can extract a QualificationResult from
    // the transcript after the fact. The job is idempotent on callId, and
    // the worker skips when aiAnalysis is already populated, so re-running
    // finalize never double-bills.
    //
    // The enqueue is wrapped in `withTimeout`: BullMQ Queue.add holds
    // commands on the offline queue when Redis is unreachable
    // (`maxRetriesPerRequest: null` is required for the worker side),
    // which without this guard blocks the HTTP request indefinitely. The
    // 2 s ceiling is much larger than a healthy enqueue (~10–50 ms) and
    // much smaller than the 5 s client-side timeout we saw stall against.
    if (!aiAnalysisPayload && call.transcript && call.transcript.trim().length > 0) {
        try {
            await withTimeout(enqueueAnalyze(id), 2000, 'enqueueAnalyze')
            opsLog('info', 'ai_call_analyze_enqueued_on_finalize', {
                callId: id,
                reason: 'no_end_call_tool_result',
                transcriptChars: call.transcript.length,
            })
        } catch (err: any) {
            // Don't surface a 500 here — finalize already succeeded in the
            // primary path (Call row is up to date). A failed enqueue means
            // Redis is unhealthy or absent; UI just won't show aiAnalysis
            // until the operator retries via the manual re-analyze action.
            opsLog('error', 'ai_call_analyze_enqueue_failed', {
                callId: id,
                error: err.message ?? String(err),
            })
        }
    }

    return NextResponse.json({
        ok: true,
        callId: id,
        sessionStatus,
        createdTask,
    })
}

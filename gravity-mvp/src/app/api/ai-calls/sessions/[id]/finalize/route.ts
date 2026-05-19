/* eslint-disable @typescript-eslint/no-explicit-any -- Prisma client types
   for AI-call models may not be regenerated on every dev box. */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { opsLog } from '@/lib/opsLog'
import { enqueueAnalyze } from '@/lib/queue/queues'

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
 *      manager_task?: { should_create: boolean, summary?: string, priority?: 'high'|'normal'|'low' }
 *      transfer_reason?: string
 *      lead_data?: Record<string, string>
 *    }
 *    leadData?: Record<string, string>
 *    transcript?: Array<{ role: 'user'|'assistant', content: string }>
 *  }
 *
 * Side-effects:
 *   - Call.aiSessionStatus → 'ended' | 'failed' | 'transferring'
 *   - Call.aiAnalysis ← result JSON (incl. lead_data merged in)
 *   - Call.aiSummary ← result.lead_summary
 *   - Call.aiTransferReason ← result.transfer_reason
 *   - Call.endedAt, durationSec — computed
 *   - Optionally creates a Task for the manager when
 *     result.manager_task.should_create is true.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params
    if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })

    let body: any
    try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

    const call = await prisma.call.findUnique({ where: { id } })
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

    await (prisma as any).call.update({
        where: { id },
        data: {
            status: 'completed',
            endedAt,
            durationSec,
            hangupCause: 'NORMAL_CLEARING',
            aiSessionStatus: sessionStatus,
            aiAnalysis: aiAnalysisPayload as any,
            aiSummary: aiAnalysisPayload?.lead_summary ?? null,
            aiTransferReason: result?.transfer_reason ?? null,
        } as any,
    })

    opsLog('info', 'ai_call_finalized', {
        callId: id,
        reason,
        sessionStatus,
        qualification: aiAnalysisPayload?.qualification_status,
        taskId: createdTask?.id,
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

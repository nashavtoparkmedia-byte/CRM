/* eslint-disable @typescript-eslint/no-explicit-any -- legacy event emitter is CommonJS */
import {
    ContractValidationError,
    CREATE_IDEMPOTENT_TASK_COMMAND_V1,
    TaskIdempotencyConflictError,
} from '@/contracts/work-management/v1'
import { createIdempotentTaskV1 } from '@/modules/work-management/public/v1'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { enqueueAnalyze } from '@/lib/queue/queues'
import { _createPersistEvents } from '@/lib/ai-call/event-emitter'
import { aiCallFinalizationPrismaPort } from '../internal/ai-calls/ai-call-finalization-prisma-adapter'
import { createAiCallFinalizationOperation } from './ai-call-finalization'

const persistEvents = _createPersistEvents()

function withTimeout<T>(promise: Promise<T>, ms: number, tag: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout_${tag}_after_${ms}ms`)), ms)
    })
    return Promise.race([promise, deadline]).finally(() => { if (timer) clearTimeout(timer) }) as Promise<T>
}

export const finalizeAiCall = createAiCallFinalizationOperation({
    persistence: aiCallFinalizationPrismaPort,
    tasks: {
        async create(command) {
            return createIdempotentTaskV1({
                contract: CREATE_IDEMPOTENT_TASK_COMMAND_V1,
                idempotencyKey: command.idempotencyKey,
                data: command.data,
            })
        },
        isPermanentError(error) {
            return error instanceof ContractValidationError || error instanceof TaskIdempotencyConflictError
        },
    },
    sideEffects: {
        async onAccepted({ call, request, terminal, validationIssues }) {
            if (validationIssues.length > 0) {
                opsLog('warn', 'ai_outcome_schema_validation_issues', {
                    callId: call.id,
                    scenarioId: call.aiScenarioId,
                    issuesCount: validationIssues.length,
                    issues: validationIssues.slice(0, 10),
                })
            }

            opsLog('info', 'ai_call_finalized', {
                callId: call.id,
                reason: request.reason,
                sessionStatus: terminal.aiSessionStatus,
                qualification: terminal.aiAnalysis?.qualification_status,
                aiOutcome: terminal.aiOutcome,
                aiOutcomeReason: terminal.aiOutcomeReason,
                qualificationScore: terminal.qualificationScore,
                structuredLeadDataFieldsCount: Object.keys(terminal.leadDataStructured).length,
                validationIssuesCount: validationIssues.length,
            })

            const completedVia = terminal.aiSessionStatus === 'failed'
                ? 'bridge_error'
                : request.reason === 'transferred'
                    ? 'llm_transfer_to_manager'
                    : request.reason === 'completed'
                        ? terminal.aiOutcome === 'dropped_no_input' ? 'silence_timeout' : 'llm_end_call'
                        : 'ws_close'
            const maxBridgeSeq = request.events.reduce(
                (maximum: number, event: any) => typeof event?.seq === 'number' && event.seq > maximum
                    ? event.seq
                    : maximum,
                0,
            )
            const eventsResult = await persistEvents({
                events: [
                    ...request.events,
                    {
                        type: 'call_completed',
                        seq: maxBridgeSeq + 1,
                        occurredAt: terminal.endedAt.toISOString(),
                        payload: {
                            outcome: terminal.aiOutcome,
                            hangup_cause: terminal.hangupCause,
                            total_ms: terminal.durationSec * 1_000,
                            completed_via: completedVia,
                            validation_issues_count: validationIssues.length,
                        },
                    },
                ],
                callId: call.id,
                opsLog,
            })
            opsLog('info', 'ai_call_events_persisted', {
                callId: call.id,
                inserted: eventsResult.inserted,
                skipped: eventsResult.skipped,
                errored: eventsResult.errored,
                issues: eventsResult.issues.slice(0, 5),
            })

            if (!terminal.aiAnalysis && call.transcript?.trim()) {
                try {
                    await withTimeout(enqueueAnalyze(call.id), 2_000, 'enqueueAnalyze')
                    opsLog('info', 'ai_call_analyze_enqueued_on_finalize', {
                        callId: call.id,
                        reason: 'no_end_call_tool_result',
                        transcriptChars: call.transcript.length,
                    })
                } catch (error) {
                    opsLog('error', 'ai_call_analyze_enqueue_failed', {
                        callId: call.id,
                        error: error instanceof Error ? error.message : String(error),
                    })
                }
            }
        },
    },
})

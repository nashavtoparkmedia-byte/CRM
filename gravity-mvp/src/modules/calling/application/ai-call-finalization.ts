import { createHash } from 'node:crypto'
import type { CreateTaskDataV1 } from '@/contracts/work-management/v1'
import {
    computeOutcome,
    normalizeQualificationScore,
    tagWithValidationIssues,
} from '@/lib/ai-call/outcome-mapper'
import { validateLeadData } from '@/lib/ai-call/scenario-schema'
import {
    aiCallTranscriptMessagesSnapshotSha256,
    normalizeAiCallTranscriptMessage,
    type AiCallTranscriptSnapshotV1,
    type AiCallTranscriptMessageInput,
} from './ai-call-transcript'

const CANONICAL_TRANSCRIPT_SNAPSHOT = Symbol('canonical-ai-call-transcript-snapshot')

export const AI_CALL_FINALIZATION_METADATA_KEY = 'aiCallFinalizationV1' as const
// Short enough for the Bridge's bounded 500 ms / 1.5 s replay window to
// recover a crashed worker; safe because the owner command is idempotent and
// the monotonically increasing lease token fences late completions.
export const AI_CALL_FINALIZATION_LEASE_MS = 1_000
export const AI_CALL_FINALIZATION_MAX_FAILURES = 3
export const AI_CALL_FINALIZATION_RETRY_BACKOFF_MS = [500, 1_500] as const

type JsonPrimitive = string | number | boolean | null
export type FinalizationJson = JsonPrimitive | FinalizationJson[] | { [key: string]: FinalizationJson }

export interface AiCallFinalizationInput {
    callUuid: string | null
    reason: string
    result: {
        qualification_status: 'qualified' | 'not_qualified' | 'unclear'
        lead_summary: string | null
        reason: string | null
        qualification_score: number | null
        transfer_reason: string | null
        manager_task: {
            should_create: boolean
            summary: string | null
            priority: 'high' | 'normal' | 'low'
        }
        lead_data: Record<string, FinalizationJson>
    } | null
    leadData: Record<string, FinalizationJson> | null
    transcript: Array<{ role: 'user' | 'assistant'; content: string }>
    transcriptItems: AiCallTranscriptMessageInput[]
    transcriptRevision: number
    realUserUtterances: number
    events: unknown[]
}

export interface AiCallFinalizationCall {
    id: string
    status: string
    startedAt: Date | null
    endedAt: Date | null
    aiSessionStatus: string | null
    aiOutcome: string | null
    driverId: string | null
    contactId: string | null
    managerId: string | null
    aiScenarioId: string | null
    transcript: string | null
    metadata: unknown
    aiScenario: { outcomeSchema: unknown } | null
    /** Present only for a campaign Call whose owning campaign froze its scenario. */
    frozenOutcomeSchema?: unknown
}

export interface AiCallTerminalUpdate {
    status: 'completed'
    endedAt: Date
    durationSec: number
    hangupCause: 'NORMAL_CLEARING'
    aiSessionStatus: 'ended' | 'failed' | 'transferring'
    aiAnalysis: Record<string, FinalizationJson> | null
    aiSummary: string | null
    aiTransferReason: string | null
    aiOutcome: string
    aiOutcomeReason: string
    qualificationScore: number | null
    leadDataStructured: Record<string, FinalizationJson>
}

export type FollowUpStateV1 =
    | 'not_required'
    | 'pending'
    | 'in_progress'
    | 'retry_wait'
    | 'completed'
    | 'terminal_failure'

export interface AiCallFinalizationJournalV1 {
    version: 1
    finalizationId: string
    fingerprint: string
    acceptedAt: string
    sessionStatus: AiCallTerminalUpdate['aiSessionStatus']
    transcriptRevision: number | null
    transcriptSnapshotSha256: string | null
    followUp: {
        state: FollowUpStateV1
        idempotencyKey: string | null
        taskData: CreateTaskDataV1 | null
        attempts: number
        retryableFailures: number
        nextAttemptAt: string | null
        leaseToken: string | null
        leaseUntil: string | null
        task: { id: string; title: string } | null
        failure: { code: string; message: string; retryable: boolean; at: string } | null
    }
}

export type FinalizationAcceptance =
    | { kind: 'accepted'; journal: AiCallFinalizationJournalV1 }
    | { kind: 'duplicate'; journal: AiCallFinalizationJournalV1 }
    | { kind: 'conflict' }
    | { kind: 'transcript_changed' }
    | { kind: 'legacy_terminal' }
    | { kind: 'not_found' }

export type FollowUpClaim =
    | { kind: 'claimed'; journal: AiCallFinalizationJournalV1; leaseToken: string }
    | { kind: 'settled' | 'busy' | 'not_due'; journal: AiCallFinalizationJournalV1 }

export interface AiCallFinalizationPersistencePort {
    findCall(callId: string): Promise<AiCallFinalizationCall | null>
    accept(input: {
        callId: string
        fingerprint: string
        journal: AiCallFinalizationJournalV1
        terminal: AiCallTerminalUpdate
    }): Promise<FinalizationAcceptance>
    claimFollowUp(input: {
        callId: string
        fingerprint: string
        now: Date
        leaseMs: number
    }): Promise<FollowUpClaim>
    completeFollowUp(input: {
        callId: string
        fingerprint: string
        leaseToken: string
        task: { id: string; title: string }
        now: Date
    }): Promise<AiCallFinalizationJournalV1>
    failFollowUp(input: {
        callId: string
        fingerprint: string
        leaseToken: string
        now: Date
        retryable: boolean
        code: string
        message: string
        maxFailures: number
        retryBackoffMs: readonly number[]
    }): Promise<AiCallFinalizationJournalV1>
}

export interface AiCallFinalizationSideEffects {
    onAccepted(input: {
        call: AiCallFinalizationCall
        request: AiCallFinalizationInput
        terminal: AiCallTerminalUpdate
        validationIssues: unknown[]
    }): Promise<void>
}

export interface IdempotentTaskCommandPort {
    create(command: {
        idempotencyKey: string
        data: CreateTaskDataV1
    }): Promise<{ task: { id: string; title: string } }>
    isPermanentError(error: unknown): boolean
}

export type FinalizeAiCallResult =
    | {
        kind: 'success'
        callId: string
        sessionStatus: AiCallTerminalUpdate['aiSessionStatus']
        createdTask: { id: string; title: string } | null
        duplicate: boolean
        followUpStatus: 'not_required' | 'completed'
    }
    | { kind: 'not_found' }
    | {
        kind: 'conflict'
        reason: 'different_terminal_payload' | 'legacy_terminal_without_journal' | 'transcript_snapshot_changed'
    }
    | {
        kind: 'retryable'
        callId: string
        followUpStatus: 'in_progress' | 'retry_wait'
        retryAfterMs: number
    }
    | {
        kind: 'terminal_failure'
        callId: string
        failure: { code: string; message: string; retryable: false }
    }

export class AiCallFinalizationInputError extends Error {
    readonly code = 'INVALID_FINALIZATION_PAYLOAD' as const

    constructor(message: string) {
        super(message)
        this.name = 'AiCallFinalizationInputError'
    }
}

function invalid(message: string): never {
    throw new AiCallFinalizationInputError(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJson(value: unknown): value is FinalizationJson {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
    if (typeof value === 'number') return Number.isFinite(value)
    if (Array.isArray(value)) return value.every(isJson)
    return isRecord(value) && Object.values(value).every(isJson)
}

function isIsoTimestamp(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function nullableBoundedString(value: unknown, field: string, max = 10_000): string | null {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string' || value.length > max) invalid(`${field} must be a string or null`)
    return value
}

function jsonObject(value: unknown, field: string): Record<string, FinalizationJson> {
    if (!isRecord(value) || !isJson(value)) invalid(`${field} must be a JSON object`)
    return value as Record<string, FinalizationJson>
}

export function parseAiCallFinalizationInput(input: unknown): AiCallFinalizationInput {
    if (!isRecord(input)) invalid('body must be an object')

    const callUuid = nullableBoundedString(input.callUuid, 'callUuid', 255)
    const reason = input.reason === undefined ? 'closed' : nullableBoundedString(input.reason, 'reason', 128)
    if (!reason || reason.trim() === '') invalid('reason must be a non-empty string')

    let result: AiCallFinalizationInput['result'] = null
    if (input.result !== undefined && input.result !== null) {
        if (!isRecord(input.result)) invalid('result must be an object or null')
        const raw = input.result
        if (!['qualified', 'not_qualified', 'unclear'].includes(String(raw.qualification_status))) {
            invalid('result.qualification_status is invalid')
        }
        if (
            raw.qualification_score !== undefined
            && raw.qualification_score !== null
            && (typeof raw.qualification_score !== 'number' || !Number.isFinite(raw.qualification_score))
        ) invalid('result.qualification_score must be a finite number or null')

        let managerTask: { should_create: boolean; summary: string | null; priority: 'high' | 'normal' | 'low' }
        if (raw.manager_task === undefined || raw.manager_task === null) {
            managerTask = { should_create: false, summary: null, priority: 'normal' }
        } else {
            if (!isRecord(raw.manager_task)) invalid('result.manager_task must be an object')
            if (typeof raw.manager_task.should_create !== 'boolean') {
                invalid('result.manager_task.should_create must be a boolean')
            }
            const priority = raw.manager_task.priority ?? 'normal'
            if (!['high', 'normal', 'low'].includes(String(priority))) {
                invalid('result.manager_task.priority is invalid')
            }
            managerTask = {
                should_create: raw.manager_task.should_create,
                summary: nullableBoundedString(raw.manager_task.summary, 'result.manager_task.summary'),
                priority: priority as 'high' | 'normal' | 'low',
            }
        }

        result = {
            qualification_status: raw.qualification_status as 'qualified' | 'not_qualified' | 'unclear',
            lead_summary: nullableBoundedString(raw.lead_summary, 'result.lead_summary'),
            reason: nullableBoundedString(raw.reason, 'result.reason'),
            qualification_score: raw.qualification_score == null ? null : raw.qualification_score as number,
            transfer_reason: nullableBoundedString(raw.transfer_reason, 'result.transfer_reason'),
            manager_task: managerTask,
            lead_data: raw.lead_data == null ? {} : jsonObject(raw.lead_data, 'result.lead_data'),
        }
    }

    const leadData = input.leadData == null ? null : jsonObject(input.leadData, 'leadData')

    let transcript: AiCallFinalizationInput['transcript'] = []
    if (input.transcript !== undefined) {
        if (!Array.isArray(input.transcript)) invalid('transcript must be an array')
        transcript = input.transcript.map((item, index) => {
            if (!isRecord(item) || !['user', 'assistant'].includes(String(item.role)) || typeof item.content !== 'string') {
                invalid(`transcript[${index}] is invalid`)
            }
            return { role: item.role as 'user' | 'assistant', content: item.content }
        })
    }

    let transcriptItems: AiCallTranscriptMessageInput[] = []
    if (input.transcriptItems !== undefined) {
        if (!Array.isArray(input.transcriptItems)) invalid('transcriptItems must be an array')
        const canonicalSnapshot = (input as Record<PropertyKey, unknown>)[CANONICAL_TRANSCRIPT_SNAPSHOT] === true
        transcriptItems = input.transcriptItems.map((item, index) => {
            if (!isRecord(item)) invalid(`transcriptItems[${index}] is invalid`)
            try {
                return normalizeAiCallTranscriptMessage({
                    ...item,
                    source: canonicalSnapshot ? item.source : 'audio_bridge',
                })
            } catch {
                invalid(`transcriptItems[${index}] is invalid`)
            }
        })
    }

    const transcriptRevision = input.transcriptRevision === undefined
        ? transcriptItems.length
        : input.transcriptRevision
    if (!Number.isSafeInteger(transcriptRevision) || (transcriptRevision as number) < 0) {
        invalid('transcriptRevision must be a non-negative integer')
    }

    const realUserUtterances = input.realUserUtterances === undefined
        ? transcript.filter((item) => item.role === 'user').length
        : input.realUserUtterances
    if (
        typeof realUserUtterances !== 'number'
        || !Number.isInteger(realUserUtterances)
        || realUserUtterances < 0
    ) invalid('realUserUtterances must be a non-negative integer')

    if (input.events !== undefined && !Array.isArray(input.events)) invalid('events must be an array')

    return {
        callUuid,
        reason,
        result,
        leadData,
        transcript,
        transcriptItems,
        transcriptRevision: transcriptRevision as number,
        realUserUtterances,
        events: input.events ?? [],
    }
}

function canonicalJson(value: FinalizationJson): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

export function aiCallFinalizationFingerprint(input: AiCallFinalizationInput): string {
    const terminalPayload: FinalizationJson = {
        reason: input.reason,
        result: input.result as unknown as FinalizationJson,
        leadData: input.leadData,
        realUserUtterances: input.realUserUtterances,
        transcriptItems: [...input.transcriptItems]
            .sort((left, right) => left.ordinal - right.ordinal || left.messageId.localeCompare(right.messageId))
            .map((message) => ({
                messageId: message.messageId,
                ordinal: message.ordinal,
                segmentRevision: message.segmentRevision,
                role: message.role,
                content: message.content,
                final: message.final,
                source: message.source,
            })),
    }
    return createHash('sha256').update(canonicalJson(terminalPayload)).digest('hex')
}

export function aiCallFinalizationId(callId: string): string {
    return `ai-call-finalization:v1:${callId}`
}

export function aiCallFollowUpIdempotencyKey(callId: string): string {
    return `ai-call-finalization-follow-up:v1:${callId}`
}

export function readAiCallFinalizationJournal(metadata: unknown): AiCallFinalizationJournalV1 | null {
    if (!isRecord(metadata)) return null
    const value = metadata[AI_CALL_FINALIZATION_METADATA_KEY]
    if (!isRecord(value) || value.version !== 1) return null
    if (
        typeof value.finalizationId !== 'string'
        || !value.finalizationId.startsWith('ai-call-finalization:v1:')
        || !/^[0-9a-f]{64}$/.test(String(value.fingerprint))
        || !isIsoTimestamp(value.acceptedAt)
        || !['ended', 'failed', 'transferring'].includes(String(value.sessionStatus))
        || (value.transcriptRevision !== undefined && value.transcriptRevision !== null && (
            !Number.isSafeInteger(value.transcriptRevision) || (value.transcriptRevision as number) < 0
        ))
        || (value.transcriptSnapshotSha256 !== undefined && value.transcriptSnapshotSha256 !== null
            && !/^[0-9a-f]{64}$/.test(String(value.transcriptSnapshotSha256)))
        || !isRecord(value.followUp)
    ) return null
    const followUp = value.followUp
    const state = followUp.state
    if (
        !['not_required', 'pending', 'in_progress', 'retry_wait', 'completed', 'terminal_failure']
            .includes(String(state))
        || !Number.isInteger(followUp.attempts)
        || (followUp.attempts as number) < 0
        || !Number.isInteger(followUp.retryableFailures)
        || (followUp.retryableFailures as number) < 0
        || (followUp.idempotencyKey !== null && typeof followUp.idempotencyKey !== 'string')
        || (followUp.taskData !== null && !isRecord(followUp.taskData))
        || (followUp.nextAttemptAt !== null && !isIsoTimestamp(followUp.nextAttemptAt))
        || (followUp.leaseToken !== null && typeof followUp.leaseToken !== 'string')
        || (followUp.leaseUntil !== null && !isIsoTimestamp(followUp.leaseUntil))
        || (followUp.task !== null && (
            !isRecord(followUp.task)
            || typeof followUp.task.id !== 'string'
            || typeof followUp.task.title !== 'string'
        ))
        || (followUp.failure !== null && (
            !isRecord(followUp.failure)
            || typeof followUp.failure.code !== 'string'
            || typeof followUp.failure.message !== 'string'
            || typeof followUp.failure.retryable !== 'boolean'
            || !isIsoTimestamp(followUp.failure.at)
        ))
    ) return null
    if (state === 'not_required' && (followUp.idempotencyKey !== null || followUp.taskData !== null)) return null
    if (state !== 'not_required' && (!followUp.idempotencyKey || !followUp.taskData)) return null
    if (state === 'completed' && !followUp.task) return null
    if (state === 'in_progress' && (!followUp.leaseToken || !followUp.leaseUntil)) return null
    if (state !== 'in_progress' && (followUp.leaseToken !== null || followUp.leaseUntil !== null)) return null
    return {
        ...(value as unknown as AiCallFinalizationJournalV1),
        transcriptRevision: typeof value.transcriptRevision === 'number' ? value.transcriptRevision : null,
        transcriptSnapshotSha256: typeof value.transcriptSnapshotSha256 === 'string'
            ? value.transcriptSnapshotSha256
            : null,
    }
}

export function metadataWithAiCallFinalizationJournal(
    metadata: unknown,
    journal: AiCallFinalizationJournalV1,
): Record<string, unknown> {
    const record = isRecord(metadata) ? metadata : {}
    return { ...record, [AI_CALL_FINALIZATION_METADATA_KEY]: journal }
}

function buildTaskData(call: AiCallFinalizationCall, analysis: AiCallTerminalUpdate['aiAnalysis']): CreateTaskDataV1 | null {
    const managerTask = analysis?.manager_task
    if (!isRecord(managerTask) || managerTask.should_create !== true || !call.driverId) return null
    const priority = managerTask.priority === 'high' ? 'high' : managerTask.priority === 'low' ? 'low' : 'medium'
    return {
        driverId: call.driverId,
        contactId: call.contactId,
        source: 'auto',
        type: 'ai_call_followup',
        title: `AI-звонок: ${typeof analysis?.lead_summary === 'string' ? analysis.lead_summary : 'результат разговора'}`,
        description: typeof managerTask.summary === 'string'
            ? managerTask.summary
            : typeof analysis?.reason === 'string' ? analysis.reason : null,
        priority,
        status: 'todo',
        createdBy: call.managerId,
        metadata: {
            aiCallId: call.id,
            qualification: typeof analysis?.qualification_status === 'string'
                ? analysis.qualification_status
                : 'unclear',
        },
    }
}

function buildTerminal(
    call: AiCallFinalizationCall,
    request: AiCallFinalizationInput,
    endedAt: Date,
): { terminal: AiCallTerminalUpdate; validationIssues: unknown[] } {
    const sessionStatus: AiCallTerminalUpdate['aiSessionStatus'] =
        request.reason === 'completed' ? 'ended'
            : request.reason === 'transferred' ? 'transferring'
                : request.reason === 'closed' ? 'ended' : 'failed'
    const leadData = request.leadData ?? request.result?.lead_data ?? {}
    const analysis: AiCallTerminalUpdate['aiAnalysis'] = request.result
        ? {
            qualification_status: request.result.qualification_status,
            lead_summary: request.result.lead_summary,
            reason: request.result.reason,
            qualification_score: request.result.qualification_score,
            transfer_reason: request.result.transfer_reason,
            manager_task: request.result.manager_task as unknown as FinalizationJson,
            lead_data: leadData,
        }
        : null
    const outcome = computeOutcome({
        aiAnalysis: analysis,
        reason: request.reason,
        sessionStatus,
        realUserUtterances: request.realUserUtterances,
    })
    const outcomeSchema = Object.prototype.hasOwnProperty.call(call, 'frozenOutcomeSchema')
        ? call.frozenOutcomeSchema
        : call.aiScenario?.outcomeSchema ?? null
    const validation = validateLeadData(analysis?.lead_data ?? null, outcomeSchema)
    const startedAt = call.startedAt ?? endedAt
    const durationSec = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000))

    return {
        terminal: {
            status: 'completed',
            endedAt,
            durationSec,
            hangupCause: 'NORMAL_CLEARING',
            aiSessionStatus: sessionStatus,
            aiAnalysis: analysis,
            aiSummary: request.result?.lead_summary ?? null,
            aiTransferReason: request.result?.transfer_reason ?? null,
            aiOutcome: outcome.outcome,
            aiOutcomeReason: tagWithValidationIssues(outcome.reason, validation.issues.length),
            qualificationScore: normalizeQualificationScore(request.result?.qualification_score),
            leadDataStructured: validation.data as Record<string, FinalizationJson>,
        },
        validationIssues: validation.issues,
    }
}

function responseFromSettled(
    callId: string,
    journal: AiCallFinalizationJournalV1,
    duplicate: boolean,
    nowMs: number,
): FinalizeAiCallResult {
    if (journal.followUp.state === 'not_required' || journal.followUp.state === 'completed') {
        return {
            kind: 'success',
            callId,
            sessionStatus: journal.sessionStatus,
            createdTask: journal.followUp.task,
            duplicate,
            followUpStatus: journal.followUp.state,
        }
    }
    if (journal.followUp.state === 'terminal_failure') {
        return {
            kind: 'terminal_failure',
            callId,
            failure: {
                code: journal.followUp.failure?.code ?? 'TASK_COMMAND_TERMINAL_FAILURE',
                message: journal.followUp.failure?.message ?? 'follow-up Task creation failed permanently',
                retryable: false,
            },
        }
    }
    const retryAt = journal.followUp.state === 'retry_wait' && journal.followUp.nextAttemptAt
        ? new Date(journal.followUp.nextAttemptAt).getTime()
        : journal.followUp.leaseUntil
            ? new Date(journal.followUp.leaseUntil).getTime()
            : nowMs + AI_CALL_FINALIZATION_LEASE_MS
    return {
        kind: 'retryable',
        callId,
        followUpStatus: journal.followUp.state === 'retry_wait' ? 'retry_wait' : 'in_progress',
        retryAfterMs: Math.max(1, retryAt - nowMs),
    }
}

function errorDetails(error: unknown): { code: string; message: string } {
    const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : null
    const ownerCode = typeof record?.code === 'string' ? record.code : null
    if (ownerCode && ['TASK_IDEMPOTENCY_CONFLICT', 'INVALID_CONTRACT', 'UNSUPPORTED_CONTRACT_VERSION'].includes(ownerCode)) {
        return {
            code: ownerCode,
            message: (error instanceof Error ? error.message : 'Work Management rejected the command').slice(0, 1_000),
        }
    }
    return {
        code: 'TASK_COMMAND_TRANSIENT_FAILURE',
        message: 'Work Management task creation did not complete',
    }
}

interface FollowUpExecutionDependencies {
    persistence: AiCallFinalizationPersistencePort
    tasks: IdempotentTaskCommandPort
    clock: () => Date
    leaseMs: number
    maxFailures: number
    retryBackoffMs: readonly number[]
}

async function executeAcceptedFollowUp(
    callId: string,
    fingerprint: string,
    duplicate: boolean,
    deps: FollowUpExecutionDependencies,
): Promise<FinalizeAiCallResult> {
    const claimNow = deps.clock()
    const claim = await deps.persistence.claimFollowUp({
        callId,
        fingerprint,
        now: claimNow,
        leaseMs: deps.leaseMs,
    })
    let current = claim.journal
    if (claim.kind !== 'claimed') {
        return responseFromSettled(callId, current, duplicate, deps.clock().getTime())
    }

    const taskDataForAttempt = current.followUp.taskData
    const idempotencyKey = current.followUp.idempotencyKey
    if (!taskDataForAttempt || !idempotencyKey) {
        throw new Error('accepted follow-up journal is missing its command data')
    }

    try {
        const taskResult = await deps.tasks.create({ idempotencyKey, data: taskDataForAttempt })
        current = await deps.persistence.completeFollowUp({
            callId,
            fingerprint,
            leaseToken: claim.leaseToken,
            task: taskResult.task,
            now: deps.clock(),
        })
    } catch (error) {
        const permanent = deps.tasks.isPermanentError(error)
        const details = errorDetails(error)
        current = await deps.persistence.failFollowUp({
            callId,
            fingerprint,
            leaseToken: claim.leaseToken,
            now: deps.clock(),
            retryable: !permanent,
            code: details.code,
            message: details.message,
            maxFailures: deps.maxFailures,
            retryBackoffMs: deps.retryBackoffMs,
        })
    }

    return responseFromSettled(callId, current, duplicate, deps.clock().getTime())
}

export function createAiCallFinalizationOperation(deps: {
    persistence: AiCallFinalizationPersistencePort
    tasks: IdempotentTaskCommandPort
    sideEffects?: AiCallFinalizationSideEffects
    clock?: () => Date
    leaseMs?: number
    maxFailures?: number
    retryBackoffMs?: readonly number[]
}) {
    const clock = deps.clock ?? (() => new Date())
    const leaseMs = deps.leaseMs ?? AI_CALL_FINALIZATION_LEASE_MS
    const maxFailures = deps.maxFailures ?? AI_CALL_FINALIZATION_MAX_FAILURES
    const retryBackoffMs = deps.retryBackoffMs ?? AI_CALL_FINALIZATION_RETRY_BACKOFF_MS

    return async function finalizeAiCall(callId: string, rawInput: unknown): Promise<FinalizeAiCallResult> {
        const request = parseAiCallFinalizationInput(rawInput)
        if (request.transcriptItems.some((message) => !message.final)) {
            throw new AiCallFinalizationInputError('terminal transcript snapshot contains an interim segment')
        }
        const call = await deps.persistence.findCall(callId)
        if (!call) return { kind: 'not_found' }

        const fingerprint = aiCallFinalizationFingerprint(request)
        const now = clock()
        const { terminal, validationIssues } = buildTerminal(call, request, now)
        const taskData = buildTaskData(call, terminal.aiAnalysis)
        const journal: AiCallFinalizationJournalV1 = {
            version: 1,
            finalizationId: aiCallFinalizationId(callId),
            fingerprint,
            acceptedAt: now.toISOString(),
            sessionStatus: terminal.aiSessionStatus,
            transcriptRevision: request.transcriptRevision,
            transcriptSnapshotSha256: aiCallTranscriptMessagesSnapshotSha256(request.transcriptItems),
            followUp: {
                state: taskData ? 'pending' : 'not_required',
                idempotencyKey: taskData ? aiCallFollowUpIdempotencyKey(callId) : null,
                taskData,
                attempts: 0,
                retryableFailures: 0,
                nextAttemptAt: null,
                leaseToken: null,
                leaseUntil: null,
                task: null,
                failure: null,
            },
        }

        const acceptance = await deps.persistence.accept({ callId, fingerprint, journal, terminal })
        if (acceptance.kind === 'not_found') return { kind: 'not_found' }
        if (acceptance.kind === 'conflict') {
            return { kind: 'conflict', reason: 'different_terminal_payload' }
        }
        if (acceptance.kind === 'transcript_changed') {
            return { kind: 'conflict', reason: 'transcript_snapshot_changed' }
        }
        if (acceptance.kind === 'legacy_terminal') {
            return { kind: 'conflict', reason: 'legacy_terminal_without_journal' }
        }
        const duplicate = acceptance.kind === 'duplicate'
        const current = acceptance.journal

        if (!duplicate && deps.sideEffects) {
            try {
                await deps.sideEffects.onAccepted({ call, request, terminal, validationIssues })
            } catch {
                // Observability/timeline/analyze hooks are explicitly best-effort.
            }
        }

        if (current.followUp.state === 'not_required' || current.followUp.state === 'completed'
            || current.followUp.state === 'terminal_failure') {
            return responseFromSettled(callId, current, duplicate, clock().getTime())
        }

        return executeAcceptedFollowUp(callId, fingerprint, duplicate, {
            persistence: deps.persistence,
            tasks: deps.tasks,
            clock,
            leaseMs,
            maxFailures,
            retryBackoffMs,
        })
    }
}

export function createAiCallFinalizationRecoveryByIdentityOperation(deps: {
    persistence: AiCallFinalizationPersistencePort
    tasks: IdempotentTaskCommandPort
    clock?: () => Date
    leaseMs?: number
    maxFailures?: number
    retryBackoffMs?: readonly number[]
}) {
    const clock = deps.clock ?? (() => new Date())
    const leaseMs = deps.leaseMs ?? AI_CALL_FINALIZATION_LEASE_MS
    const maxFailures = deps.maxFailures ?? AI_CALL_FINALIZATION_MAX_FAILURES
    const retryBackoffMs = deps.retryBackoffMs ?? AI_CALL_FINALIZATION_RETRY_BACKOFF_MS
    return async function recoverAiCallFinalizationByIdentity(
        callId: string,
        fingerprint: string,
    ): Promise<FinalizeAiCallResult> {
        return executeAcceptedFollowUp(callId, fingerprint, true, {
            persistence: deps.persistence,
            tasks: deps.tasks,
            clock,
            leaseMs,
            maxFailures,
            retryBackoffMs,
        })
    }
}

export function createAiCallFinalizationWithTranscriptReconciliation(deps: {
    appendTranscript(callId: string, message: AiCallTranscriptMessageInput): Promise<unknown>
    snapshotTranscript(callId: string): Promise<AiCallTranscriptSnapshotV1 | null>
    finalize(callId: string, rawInput: unknown): Promise<FinalizeAiCallResult>
}) {
    return async (callId: string, rawInput: unknown): Promise<FinalizeAiCallResult> => {
        const request = parseAiCallFinalizationInput(rawInput)
        let snapshotBeforeAppend: AiCallTranscriptSnapshotV1 | null = null
        let suppliedMessages = request.transcriptItems
        if (suppliedMessages.length === 0) {
            snapshotBeforeAppend = await deps.snapshotTranscript(callId)
            if (!snapshotBeforeAppend) return { kind: 'not_found' }
            suppliedMessages = snapshotBeforeAppend.messages.length > 0
                ? []
                : request.transcript.map((message, index) => normalizeAiCallTranscriptMessage({
                    messageId: `legacy-call-transcript:v1:${index + 1}`,
                    ordinal: index + 1,
                    segmentRevision: 1,
                    role: message.role,
                    content: message.content,
                    final: true,
                    source: 'legacy_calling',
                }))
        }
        for (const message of [...suppliedMessages].sort((left, right) => left.ordinal - right.ordinal)) {
            await deps.appendTranscript(callId, message)
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const snapshot = attempt === 0 && suppliedMessages.length === 0 && snapshotBeforeAppend
                ? snapshotBeforeAppend
                : await deps.snapshotTranscript(callId)
            if (!snapshot) return { kind: 'not_found' }
            if (snapshot.messages.some((message) => !message.final)) {
                throw new AiCallFinalizationInputError('terminal transcript snapshot contains an interim segment')
            }
            const enriched = {
                ...(rawInput as Record<string, unknown>),
                transcriptItems: snapshot.messages,
                transcriptRevision: snapshot.revision,
                realUserUtterances: Object.prototype.hasOwnProperty.call(rawInput, 'realUserUtterances')
                    ? request.realUserUtterances
                    : snapshot.messages.filter((message) => message.role === 'user' && message.final).length,
                [CANONICAL_TRANSCRIPT_SNAPSHOT]: true,
            }
            const result = await deps.finalize(callId, enriched)
            if (result.kind !== 'conflict' || result.reason !== 'transcript_snapshot_changed') return result
        }
        return { kind: 'conflict', reason: 'transcript_snapshot_changed' }
    }
}

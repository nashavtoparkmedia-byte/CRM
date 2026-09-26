import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import {
    EslOriginateOutcomeUnknownError,
    EslOriginateRejectedError,
    originateAiCall,
} from '@/lib/ai-call/esl-originate'
import { channelExistsV1 } from '@/lib/freeswitch/EslClient'
import type { CallingTelephonyRuntimeConfiguration } from '../../application/calling-runtime-readiness'
import {
    CAMPAIGN_EFFECT_HORIZON_MS,
    CAMPAIGN_MAX_PREANSWER_MS,
    CAMPAIGN_PREANSWER_CHANNEL_VARIABLE,
    EFFECT_OBSERVATION_MARGIN_MS,
    aiCallCampaignLiveDialFingerprint,
    aiCallCampaignLiveDialIdentity,
} from '../../application/ai-call-campaign-live-dial'
import type {
    AiCallCampaignDialPort,
    AiCallCampaignDialRequest,
    AiCallCampaignDialResult,
} from '../../application/ai-call-campaign-runtime'
import {
    advancedProviderEffectJournal,
    initialProviderEffectJournal,
    readProviderEffectJournal,
    type ProviderEffectJournalV1,
    type ProviderEffectPhase,
} from '../../application/ai-call-provider-effect-journal'
import { CONTROLLED_REAL_CALL_MAX_ANSWERED_MS } from '../../application/controlled-real-ai-call'
import { controlledRealAiCallChannelVars } from './freeswitch-controlled-real-ai-call-adapter'

/**
 * The live campaign dial adapter.
 *
 * One durably authorized launch becomes one deterministic Call, at most one provider
 * effect, and a terminal that campaign policy — never this adapter — turns into a
 * retry or a stop. It is deliberately unreachable in this milestone: the campaign
 * runtime mode still refuses every live value, so nothing selects this port.
 *
 * The ordering is the safety contract:
 *
 *   T1  create-or-replay the exact Call, link the exact attempt, journal `prepared`
 *   T2  commit `prepared -> dispatch_started`        (durable, before any network write)
 *   N   originate for that exact fsUuid
 *   T3  commit the observation: accepted | rejected | outcome_unknown
 *
 * A crash in `prepared` proves nothing was sent. A crash from `dispatch_started`
 * onward proves nothing about acceptance, so this launch may never originate again
 * and the truth is recovered from the deterministic fsUuid and the Call's own
 * provider-written facts.
 */

export const AI_CALL_CAMPAIGN_LIVE_DIAL_METADATA_KEY = 'aiCallCampaignLiveDialV1' as const

/** Calls placed by a campaign worker are attributed to no CRM user. */
const CAMPAIGN_CALL_MANAGER_ID = null

const CAMPAIGN_IDENTITY_KEY_PREFIX = 'ai-call-campaign:v1:'

interface CampaignLiveDialDependencies {
    /** Runtime/telephony configuration; no manual admission fields exist on it. */
    readiness: () => Promise<{ ready: boolean; blockers: string[]; configuration: CallingTelephonyRuntimeConfiguration | null }>
    /** Issues the one provider effect. Split out so tests never touch a socket. */
    originate?: (input: {
        configuration: CallingTelephonyRuntimeConfiguration
        fsUuid: string
        toNumber: string
        recordingPath: string
    }) => Promise<string>
    channelExists?: (fsUuid: string) => Promise<boolean | null>
    now?: () => Date
}

function digest(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The channel variables a campaign originate carries.
 *
 * The recording and C1b hard-answer-limit variables are reused verbatim from the
 * controlled route, so there is exactly one answered-duration literal in the
 * repository. Added on top, and only here, is the pre-answer ceiling: measured on the
 * pinned build, `originate_timeout` is the only variable that moves that deadline —
 * `call_timeout` in an originate variable block is ignored and `leg_timeout` reports
 * a different cause. The manual route's dialing is untouched.
 */
export function aiCallCampaignLiveDialChannelVars(recordingPath: string): Record<string, string> {
    return {
        ...controlledRealAiCallChannelVars(recordingPath),
        [CAMPAIGN_PREANSWER_CHANNEL_VARIABLE]: String(Math.trunc(CAMPAIGN_MAX_PREANSWER_MS / 1_000)),
    }
}

export function aiCallCampaignLiveRecordingPath(fsUuid: string): string {
    return `/var/lib/freeswitch/recordings/${fsUuid}.wav`
}

function terminal(
    launchId: string,
    kind: AiCallCampaignDialResult['terminal']['kind'],
    detail: { outcomeCode?: string | null; failureCode?: string | null },
): AiCallCampaignDialResult['terminal'] {
    const failureCode = detail.failureCode ?? null
    const outcomeCode = detail.outcomeCode ?? null
    return {
        eventId: `campaign-live-terminal:${digest(`${launchId}\0${kind}\0${failureCode ?? outcomeCode ?? ''}`)}`,
        kind,
        outcomeCode,
        failureCode,
    }
}

/**
 * Provider-neutral facts only. FreeSWITCH answers a non-`+OK` originate for two very
 * different situations: a call that really was placed and not picked up, and a dial
 * that never left the switch. The reply excerpt is the only thing that separates
 * them, which is why it is carried on the rejection error.
 */
export function classifyOriginateRejection(replyExcerpt: string | null): {
    kind: 'retryable_failure' | 'permanent_failure'
    failureCode: string
} {
    const body = (replyExcerpt ?? '').toUpperCase()
    if (body.includes('NO_ANSWER') || body.includes('NO_USER_RESPONSE')) {
        return { kind: 'retryable_failure', failureCode: 'provider_no_answer' }
    }
    if (body.includes('USER_BUSY')) return { kind: 'retryable_failure', failureCode: 'provider_busy' }
    if (body.includes('NORMAL_TEMPORARY_FAILURE') || body.includes('SWITCH_CONGESTION')
        || body.includes('NETWORK_OUT_OF_ORDER') || body.includes('GATEWAY_DOWN')
        || body.includes('RECOVERY_ON_TIMER_EXPIRE') || body.includes('INVALID_GATEWAY')) {
        return { kind: 'retryable_failure', failureCode: 'provider_unavailable' }
    }
    if (body.includes('UNALLOCATED_NUMBER') || body.includes('NO_ROUTE_DESTINATION')
        || body.includes('INCOMPATIBLE_DESTINATION') || body.includes('CALL_REJECTED')) {
        return { kind: 'permanent_failure', failureCode: 'provider_rejected' }
    }
    // An unrecognised rejection body proves a call was NOT accepted, but not that it
    // is safe to dial again; campaign policy may retry only recognised transients.
    return { kind: 'permanent_failure', failureCode: 'provider_rejected' }
}

interface LiveCallRow {
    id: string
    fsUuid: string | null
    status: string
    startedAt: Date | null
    answeredAt: Date | null
    endedAt: Date | null
    hangupCause: string | null
    aiSessionStatus: string | null
    aiOutcome: string | null
    aiScenarioId: string | null
    toNumber: string
    metadata: unknown
}

const TERMINAL_CALL_STATUSES = new Set(['completed', 'failed', 'no_answer', 'busy', 'missed', 'cancelled'])

/** Has a provider/finalization fact already settled this call durably? */
export function durableCallTerminalFact(call: LiveCallRow): boolean {
    return call.endedAt !== null
        || TERMINAL_CALL_STATUSES.has(call.status)
        || call.aiSessionStatus === 'ended'
        || call.aiSessionStatus === 'failed'
        || call.aiOutcome !== null
        || call.hangupCause === 'RECOVERED_STALE_CHANNEL'
}

/**
 * Maps one settled Call to a campaign terminal. Retry policy is not decided here —
 * `recordAttemptResult` owns `maxAttempts` and backoff.
 */
export function campaignTerminalForSettledCall(
    launchId: string,
    call: LiveCallRow,
): AiCallCampaignDialResult['terminal'] {
    if (call.aiOutcome !== null && call.aiSessionStatus !== 'failed') {
        return terminal(launchId, 'success', { outcomeCode: call.aiOutcome })
    }
    if (call.answeredAt !== null && call.aiSessionStatus === null && call.hangupCause === 'RECOVERED_STALE_CHANNEL') {
        // Answered, then the channel vanished without a dialog result.
        return terminal(launchId, 'retryable_failure', { failureCode: 'call_dialog_unobserved' })
    }
    if (call.status === 'no_answer' || call.status === 'missed') {
        return terminal(launchId, 'retryable_failure', { failureCode: 'provider_no_answer' })
    }
    if (call.status === 'busy') return terminal(launchId, 'retryable_failure', { failureCode: 'provider_busy' })
    if (call.status === 'cancelled') {
        return terminal(launchId, 'retryable_failure', { failureCode: 'call_cancelled' })
    }
    if (call.aiSessionStatus === 'failed' || call.status === 'failed') {
        return terminal(launchId, 'retryable_failure', { failureCode: 'ai_runtime_failure' })
    }
    return terminal(launchId, 'success', { outcomeCode: call.aiOutcome ?? 'completed' })
}

function creatorIdFromIdentityKey(identityKey: unknown): string | null {
    if (typeof identityKey !== 'string' || !identityKey.startsWith(CAMPAIGN_IDENTITY_KEY_PREFIX)) return null
    const parts = identityKey.split(':')
    return parts.length === 4 && parts[2] !== '' ? parts[2] : null
}

export class AiCallCampaignLiveDialConflictError extends Error {
    constructor(readonly code: string) {
        super(code)
        this.name = 'AiCallCampaignLiveDialConflictError'
    }
}

export function createAiCallCampaignLiveDialPort(
    dependencies: CampaignLiveDialDependencies,
): AiCallCampaignDialPort {
    const now = dependencies.now ?? (() => new Date())
    const channelExists = dependencies.channelExists ?? channelExistsV1
    const originate = dependencies.originate ?? (async (input) => {
        await originateAiCall({
            connection: input.configuration.esl,
            fsUuid: input.fsUuid,
            dialString: input.configuration.dialStringTemplate.replace('${number}', input.toNumber.slice(1)),
            extension: input.configuration.parkExtension,
            callerIdName: 'AI Assistant',
            vars: aiCallCampaignLiveDialChannelVars(aiCallCampaignLiveRecordingPath(input.fsUuid)),
        })
        return input.fsUuid
    })

    async function readCall(callId: string): Promise<LiveCallRow | null> {
        const rows = await (prisma as unknown as {
            $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>
        }).$queryRawUnsafe<LiveCallRow[]>(`
            SELECT "id", "fsUuid", "status"::text AS "status", "startedAt", "answeredAt", "endedAt",
                   "hangupCause", "aiSessionStatus"::text AS "aiSessionStatus", "aiOutcome"::text AS "aiOutcome",
                   "aiScenarioId", "toNumber", "metadata"
            FROM "Call" WHERE "id"=$1
        `, callId)
        return rows[0] ?? null
    }

    function journalOf(call: LiveCallRow): ProviderEffectJournalV1 | null {
        return readProviderEffectJournal(call.metadata, AI_CALL_CAMPAIGN_LIVE_DIAL_METADATA_KEY)
    }

    /** Compare-and-set on the journal phase. Returns the stored journal. */
    async function advancePhase(
        callId: string,
        from: ProviderEffectPhase,
        to: ProviderEffectPhase,
        observation?: { providerReference?: string | null; providerReplyExcerpt?: string | null; failureCode?: string | null },
    ): Promise<ProviderEffectJournalV1> {
        return prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "Call" WHERE "id" = ${callId} FOR UPDATE`
            const call = await tx.call.findUnique({ where: { id: callId }, select: { metadata: true } })
            const journal = readProviderEffectJournal(call?.metadata, AI_CALL_CAMPAIGN_LIVE_DIAL_METADATA_KEY)
            if (!journal) throw new AiCallCampaignLiveDialConflictError('effect_journal_missing')
            if (journal.effectState !== from) {
                throw new AiCallCampaignLiveDialConflictError(`effect_phase_conflict:${journal.effectState}`)
            }
            const next = advancedProviderEffectJournal(journal, to, now(), observation)
            const metadata = isRecord(call?.metadata) ? { ...call.metadata } : {}
            await tx.call.update({
                where: { id: callId },
                data: { metadata: { ...metadata, [AI_CALL_CAMPAIGN_LIVE_DIAL_METADATA_KEY]: next } as never },
            })
            return next
        })
    }

    /**
     * T1. Creates or replays the exact Call and links the exact attempt, with the
     * journal at `prepared`. One transaction, before any network write, so a Call can
     * never exist unlinked and an originate can never precede the link.
     */
    async function prepare(request: AiCallCampaignDialRequest): Promise<{ call: LiveCallRow; journal: ProviderEffectJournalV1 }> {
        const { callId, fsUuid } = aiCallCampaignLiveDialIdentity(request.launchId)
        const requestFingerprint = aiCallCampaignLiveDialFingerprint({
            launchId: request.launchId,
            campaignId: request.campaignId,
            memberId: request.memberId,
            attemptNumber: request.attemptNumber,
            phoneE164: request.phoneE164,
            scenarioRef: request.scenarioRef,
            scenarioFingerprint: request.scenarioFingerprint,
        })
        const existing = await readCall(callId)
        if (existing) {
            const journal = journalOf(existing)
            if (!journal || journal.requestFingerprint !== requestFingerprint
                || journal.launchId !== request.launchId
                || existing.fsUuid !== fsUuid
                || existing.toNumber !== request.phoneE164
                || existing.aiScenarioId !== request.scenarioRef) {
                throw new AiCallCampaignLiveDialConflictError('call_identity_conflict')
            }
            return { call: existing, journal }
        }
        const preparedAt = now()
        const campaign = await prisma.aiCallCampaign.findUnique({
            where: { id: request.campaignId },
            select: { identityKey: true },
        })
        const journal = initialProviderEffectJournal({
            launchId: request.launchId,
            campaignId: request.campaignId,
            memberId: request.memberId,
            attemptNumber: request.attemptNumber,
            scenarioFingerprint: request.scenarioFingerprint,
            requestFingerprint,
            preparedAt,
            creatorId: creatorIdFromIdentityKey(campaign?.identityKey),
        })
        await prisma.$transaction(async (tx) => {
            await tx.call.create({
                data: {
                    id: callId,
                    direction: 'outbound',
                    status: 'ringing',
                    fromNumber: '',
                    toNumber: request.phoneE164,
                    // An automatic campaign call belongs to no CRM user, and the
                    // audience snapshot is provider-neutral: no driver, no contact.
                    managerId: CAMPAIGN_CALL_MANAGER_ID,
                    driverId: null,
                    contactId: null,
                    fsUuid,
                    startedAt: preparedAt,
                    isAi: true,
                    isSimulation: false,
                    aiScenarioId: request.scenarioRef,
                    aiSessionStatus: 'starting',
                    metadata: { [AI_CALL_CAMPAIGN_LIVE_DIAL_METADATA_KEY]: journal } as never,
                },
            })
            const linked = await tx.aiCallCampaignAttempt.updateMany({
                where: { launchId: request.launchId, OR: [{ callId: null }, { callId }] },
                data: { callId },
            })
            if (linked.count !== 1) {
                throw new AiCallCampaignLiveDialConflictError('attempt_link_conflict')
            }
        })
        const created = await readCall(callId)
        if (!created) throw new AiCallCampaignLiveDialConflictError('call_missing_after_prepare')
        return { call: created, journal }
    }

    /** The evidence ladder for a linked effect whose outcome is not settled yet. */
    async function settleFromEvidence(
        request: AiCallCampaignDialRequest,
        call: LiveCallRow,
        journal: ProviderEffectJournalV1,
    ): Promise<AiCallCampaignDialResult | null> {
        // 1. A durable terminal provider/finalization fact outranks every clock.
        if (durableCallTerminalFact(call)) {
            return {
                effectRef: `campaign-live:${request.launchId}`,
                callId: call.id,
                terminal: campaignTerminalForSettledCall(request.launchId, call),
            }
        }
        // 2. A persisted rejection is a settled provider fact of its own.
        if (journal.effectState === 'rejected') {
            const classified = classifyOriginateRejection(journal.providerReplyExcerpt)
            return {
                effectRef: `campaign-live:${request.launchId}`,
                callId: call.id,
                terminal: terminal(request.launchId, classified.kind, { failureCode: classified.failureCode }),
            }
        }
        // 3. FreeSWITCH still has the channel: the effect is alive, keep pending.
        if (call.fsUuid !== null && (await channelExists(call.fsUuid)) === true) return null
        const reference = call.startedAt ?? new Date(journal.preparedAt)
        // 4. Answered: the stronger per-call deadline is C1b's answered cap.
        if (call.answeredAt !== null) {
            const answeredDeadline = call.answeredAt.getTime()
                + CONTROLLED_REAL_CALL_MAX_ANSWERED_MS + EFFECT_OBSERVATION_MARGIN_MS
            if (now().getTime() < answeredDeadline) return null
        }
        // 5. Inside the recovery horizon nothing may be concluded: an absent channel
        //    is not proof that no call happened.
        if (now().getTime() < reference.getTime() + CAMPAIGN_EFFECT_HORIZON_MS) return null
        // 6. Horizon passed with no provable outcome. Permanent on purpose: dialing a
        //    lead twice is worse than dropping one uncertain attempt, and campaign
        //    policy never retries a permanent failure.
        return {
            effectRef: `campaign-live:${request.launchId}`,
            callId: call.id,
            terminal: terminal(request.launchId, 'permanent_failure', {
                failureCode: 'provider_acceptance_unresolved',
            }),
        }
    }

    return {
        async dispatch(request): Promise<AiCallCampaignDialResult | null> {
            const readiness = await dependencies.readiness()
            if (!readiness.ready || !readiness.configuration) {
                // Nothing is created and nothing is sent: the launch never started.
                return {
                    effectRef: `campaign-live-not-ready:${request.launchId}`,
                    providerAccepted: false,
                    terminal: terminal(request.launchId, 'retryable_failure', {
                        failureCode: 'campaign_live_dial_not_ready',
                    }),
                }
            }
            const prepared = await prepare(request)
            if (prepared.journal.effectState !== 'prepared') {
                // A previous execution already passed the point of no return. This is
                // reconciliation, never a second effect.
                return settleFromEvidence(request, prepared.call, prepared.journal)
            }
            const { fsUuid } = aiCallCampaignLiveDialIdentity(request.launchId)
            // T2 — durable before the network write.
            await advancePhase(prepared.call.id, 'prepared', 'dispatch_started')
            try {
                const providerReference = await originate({
                    configuration: readiness.configuration,
                    fsUuid,
                    toNumber: request.phoneE164,
                    recordingPath: aiCallCampaignLiveRecordingPath(fsUuid),
                })
                try {
                    await advancePhase(prepared.call.id, 'dispatch_started', 'accepted', { providerReference })
                } catch {
                    // The effect was accepted but saying so durably failed. Recorded as
                    // unobserved rather than lost: both phases keep the launch pending
                    // and forbid a second originate, and reconciliation resolves the
                    // outcome from the channel and the Call's own facts either way.
                    await advancePhase(prepared.call.id, 'dispatch_started', 'outcome_unknown', {
                        providerReference,
                        failureCode: 'provider_observation_failed',
                    }).catch(() => undefined)
                }
                // Accepted and linked: a real conversation settles later.
                return null
            } catch (error) {
                if (error instanceof EslOriginateRejectedError) {
                    await advancePhase(prepared.call.id, 'dispatch_started', 'rejected', {
                        providerReplyExcerpt: error.replyExcerpt,
                        failureCode: 'provider_rejected',
                    })
                    const classified = classifyOriginateRejection(error.replyExcerpt)
                    return {
                        effectRef: `campaign-live:${request.launchId}`,
                        callId: prepared.call.id,
                        // The switch refused the dial: no effect was accepted, even
                        // when the cause proves a call rang.
                        providerAccepted: false,
                        terminal: terminal(request.launchId, classified.kind, {
                            failureCode: classified.failureCode,
                        }),
                    }
                }
                // Outcome unknown covers both the ESL transport timeout — which any
                // call that rings longer than the client's observation window
                // produces — and a lost reply. The effect may well be alive, so this
                // stays pending and is never re-originated.
                const failureCode = error instanceof EslOriginateOutcomeUnknownError
                    ? 'provider_outcome_unknown'
                    : 'provider_observation_failed'
                await advancePhase(prepared.call.id, 'dispatch_started', 'outcome_unknown', { failureCode })
                    .catch(() => undefined)
                return null
            }
        },

        async reconcile(request): Promise<AiCallCampaignDialResult | null> {
            const { callId } = aiCallCampaignLiveDialIdentity(request.launchId)
            const call = await readCall(callId)
            if (!call) return null
            const journal = journalOf(call)
            if (!journal) throw new AiCallCampaignLiveDialConflictError('effect_journal_missing')
            // `prepared` proves the provider was never asked: dispatch_started never
            // committed. Settled as retryable so campaign policy — not this adapter —
            // decides whether a NEW attempt with a NEW launchId runs. No provider call.
            if (journal.effectState === 'prepared') {
                return {
                    effectRef: `campaign-live:${request.launchId}`,
                    callId: call.id,
                    providerAccepted: false,
                    terminal: terminal(request.launchId, 'retryable_failure', {
                        failureCode: 'provider_not_started',
                    }),
                }
            }
            return settleFromEvidence(request, call, journal)
        },
    }
}

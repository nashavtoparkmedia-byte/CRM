import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EslOriginateOutcomeUnknownError, EslOriginateRejectedError } from '@/lib/ai-call/esl-originate'

/**
 * The campaign live dial foundation.
 *
 * Everything here runs against an in-memory Call/attempt store and an injected
 * provider, so no socket, no database and no provider is touched. What is asserted is
 * the safety contract: one launch is one deterministic effect, the durable phase
 * decides whether an effect may be issued at all, and a recovery never dials twice.
 */

const store = vi.hoisted(() => ({
    calls: new Map<string, Record<string, unknown>>(),
    attempts: new Map<string, { launchId: string; callId: string | null }>(),
    campaigns: new Map<string, { identityKey: string }>(),
    failNextCallUpdate: false,
}))

function callRows(callId: string): Array<Record<string, unknown>> {
    const call = store.calls.get(callId)
    return call ? [call] : []
}

vi.mock('@/lib/prisma', () => {
    const tx = {
        $queryRaw: async () => [],
        call: {
            findUnique: async ({ where }: { where: { id: string } }) => store.calls.get(where.id) ?? null,
            create: async ({ data }: { data: Record<string, unknown> }) => {
                if (store.calls.has(String(data.id))) throw Object.assign(new Error('unique'), { code: 'P2002' })
                store.calls.set(String(data.id), { ...data, endedAt: null, answeredAt: null, hangupCause: null, aiOutcome: null })
                return data
            },
            update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                if (store.failNextCallUpdate) {
                    store.failNextCallUpdate = false
                    throw new Error('SIMULATED_OBSERVATION_WRITE_FAILURE')
                }
                const call = store.calls.get(where.id)
                if (!call) throw new Error('missing call')
                store.calls.set(where.id, { ...call, ...data })
                return store.calls.get(where.id)
            },
        },
        aiCallCampaignAttempt: {
            updateMany: async ({ where, data }: {
                where: { launchId: string; OR: Array<{ callId: string | null }> }
                data: { callId: string }
            }) => {
                let count = 0
                for (const [id, attempt] of store.attempts) {
                    if (attempt.launchId !== where.launchId) continue
                    const allowed = where.OR.some(clause => clause.callId === attempt.callId)
                    if (!allowed) continue
                    store.attempts.set(id, { ...attempt, callId: data.callId })
                    count++
                }
                return { count }
            },
        },
    }
    return {
        prisma: {
            ...tx,
            $queryRawUnsafe: async (_sql: string, callId: string) => callRows(callId),
            $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
            aiCallCampaign: {
                findUnique: async ({ where }: { where: { id: string } }) => store.campaigns.get(where.id) ?? null,
            },
        },
    }
})

vi.mock('@/lib/freeswitch/EslClient', () => ({
    channelExistsV1: async () => null,
    STALE_CALL_RECONCILE_GRACE_MS_V1: 90_000,
    STALE_CALL_RECONCILE_INTERVAL_MS_V1: 30_000,
    STALE_CALL_RECONCILE_LOOKBACK_MS_V1: 600_000,
}))

const {
    AI_CALL_CAMPAIGN_LIVE_DIAL_METADATA_KEY,
    aiCallCampaignLiveDialChannelVars,
    campaignTerminalForSettledCall,
    classifyOriginateRejection,
    createAiCallCampaignLiveDialPort,
    durableCallTerminalFact,
} = await import('./ai-call-campaign-live-dial-adapter')
const {
    CAMPAIGN_EFFECT_HORIZON_MS,
    CAMPAIGN_FORBIDDEN_PREANSWER_VARIABLES,
    CAMPAIGN_MAX_PREANSWER_MS,
    EFFECT_OBSERVATION_MARGIN_MS,
    MAX_PHYSICAL_EFFECT_MS,
    MIN_CAMPAIGN_EFFECT_HORIZON_MS,
    aiCallCampaignLiveDialIdentity,
    campaignOccupancyRecheckMs,
} = await import('../../application/ai-call-campaign-live-dial')
const { CONTROLLED_REAL_CALL_MAX_ANSWERED_MS } = await import('../../application/controlled-real-ai-call')
const { aiCallCampaignLaunchId } = await import('../../application/ai-call-campaign')
const { readProviderEffectJournal } = await import('../../application/ai-call-provider-effect-journal')

const CAMPAIGN_ID = 'aicc_campaign_1'
const MEMBER_ID = 'aiccm_member_1'
const LAUNCH_ID = aiCallCampaignLaunchId(MEMBER_ID, 1)
const SCENARIO_REF = 'scenario-1'

const CONFIGURATION = {
    telephonyProvider: 'freeswitch' as const,
    sttProvider: 'openai' as const,
    ttsProvider: 'yandex' as const,
    llmProvider: 'openai' as const,
    callerNumberE164: '+79001234567',
    dialStringTemplate: 'sofia/gateway/megafon/${number}' as const,
    parkExtension: '9999',
    esl: { host: '127.0.0.1', port: 8021, password: 'a-strong-machine-secret-value' },
}

function request(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        launchId: LAUNCH_ID,
        campaignId: CAMPAIGN_ID,
        memberId: MEMBER_ID,
        targetType: 'external',
        targetRef: '+79990000000',
        phoneE164: '+79990000000',
        scenarioRef: SCENARIO_REF,
        scenarioFingerprint: 'f'.repeat(64),
        scenarioSnapshot: {},
        attemptNumber: 1,
        ...overrides,
    } as never
}

let clock = new Date('2026-09-26T10:00:00.000Z')
function makePort(options: {
    originate?: () => Promise<string>
    channelExists?: () => Promise<boolean | null>
    ready?: boolean
} = {}) {
    const originate = vi.fn(options.originate ?? (async () => 'provider-reference'))
    const channelExists = vi.fn(options.channelExists ?? (async () => null))
    const port = createAiCallCampaignLiveDialPort({
        readiness: async () => (options.ready === false
            ? { ready: false, blockers: ['campaign_live_gate_disabled'], configuration: null }
            : { ready: true, blockers: [], configuration: CONFIGURATION }),
        originate,
        channelExists,
        now: () => clock,
    })
    return { port, originate, channelExists }
}

function journalOf(callId: string) {
    return readProviderEffectJournal(store.calls.get(callId)?.metadata, AI_CALL_CAMPAIGN_LIVE_DIAL_METADATA_KEY)
}

beforeEach(() => {
    store.calls.clear()
    store.attempts.clear()
    store.campaigns.clear()
    store.failNextCallUpdate = false
    store.attempts.set('attempt-1', { launchId: LAUNCH_ID, callId: null })
    store.campaigns.set(CAMPAIGN_ID, { identityKey: `ai-call-campaign:v1:u7:req-${CAMPAIGN_ID}` })
    clock = new Date('2026-09-26T10:00:00.000Z')
})

// ── identity ──────────────────────────────────────────────────────────────────

describe('deterministic campaign identity', () => {
    it('gives one launch exactly one Call id and one fsUuid, every time', () => {
        const first = aiCallCampaignLiveDialIdentity(LAUNCH_ID)
        expect(aiCallCampaignLiveDialIdentity(LAUNCH_ID)).toEqual(first)
        expect(first.callId).toMatch(/^campaign_live_[0-9a-f]{32}$/)
        expect(first.fsUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
    })

    it('gives a second attempt a different effect identity', () => {
        const second = aiCallCampaignLaunchId(MEMBER_ID, 2)
        expect(second).not.toBe(LAUNCH_ID)
        const a = aiCallCampaignLiveDialIdentity(LAUNCH_ID)
        const b = aiCallCampaignLiveDialIdentity(second)
        expect(b.callId).not.toBe(a.callId)
        expect(b.fsUuid).not.toBe(a.fsUuid)
    })

    it('refuses an identity that is not a campaign launch id', () => {
        expect(() => aiCallCampaignLiveDialIdentity('controlled-request-id-0001')).toThrow(/launch_id_invalid/)
    })
})

// ── first dispatch ────────────────────────────────────────────────────────────

describe('first dispatch', () => {
    it('creates the linked Call, journals prepared, then dispatch_started, then accepted', async () => {
        const { port, originate } = makePort()
        const { callId } = aiCallCampaignLiveDialIdentity(LAUNCH_ID)

        const result = await port.dispatch(request())

        expect(result).toBeNull()                      // linked pending, no terminal
        expect(originate).toHaveBeenCalledTimes(1)
        const call = store.calls.get(callId)!
        expect(call.managerId).toBeNull()
        expect(call.driverId).toBeNull()
        expect(call.contactId).toBeNull()
        expect(call.toNumber).toBe('+79990000000')
        expect(call.aiScenarioId).toBe(SCENARIO_REF)
        expect(call.isSimulation).toBe(false)
        expect(store.attempts.get('attempt-1')!.callId).toBe(callId)
        const journal = journalOf(callId)!
        expect(journal.effectState).toBe('accepted')
        expect(journal.launchId).toBe(LAUNCH_ID)
        expect(journal.creatorId).toBe('u7')
        expect(journal.dispatchStartedAt).not.toBeNull()
    })

    it('never opens a socket before dispatch_started is durable', async () => {
        const order: string[] = []
        const { port } = makePort({ originate: async () => { order.push('originate'); return 'ref' } })
        const { callId } = aiCallCampaignLiveDialIdentity(LAUNCH_ID)
        const originalSet = store.calls.set.bind(store.calls)
        store.calls.set = ((key: string, value: Record<string, unknown>) => {
            const phase = readProviderEffectJournal(value.metadata, AI_CALL_CAMPAIGN_LIVE_DIAL_METADATA_KEY)?.effectState
            if (phase) order.push(`phase:${phase}`)
            return originalSet(key, value)
        }) as typeof store.calls.set

        await port.dispatch(request())
        store.calls.set = originalSet

        expect(order.indexOf('phase:dispatch_started')).toBeGreaterThanOrEqual(0)
        expect(order.indexOf('phase:dispatch_started')).toBeLessThan(order.indexOf('originate'))
        expect(journalOf(callId)!.effectState).toBe('accepted')
    })

    it('does not dial when campaign live readiness is closed', async () => {
        const { port, originate } = makePort({ ready: false })
        const result = await port.dispatch(request())
        expect(originate).not.toHaveBeenCalled()
        expect(store.calls.size).toBe(0)
        expect(result?.terminal.kind).toBe('retryable_failure')
        expect(result?.terminal.failureCode).toBe('campaign_live_dial_not_ready')
        expect(result?.providerAccepted).toBe(false)
    })

    it('fails closed on a conflicting replay, without dialing', async () => {
        const { port, originate } = makePort()
        await port.dispatch(request())
        originate.mockClear()

        await expect(port.dispatch(request({ phoneE164: '+79991110000' })))
            .rejects.toThrow(/call_identity_conflict/)
        expect(originate).not.toHaveBeenCalled()
    })

    it('treats an ESL observation timeout as outcome_unknown and keeps the launch pending', async () => {
        const { port } = makePort({
            originate: async () => { throw new EslOriginateOutcomeUnknownError('ESL timeout after 10000ms (stage=awaiting_response)') },
        })
        const { callId } = aiCallCampaignLiveDialIdentity(LAUNCH_ID)

        const result = await port.dispatch(request())

        expect(result).toBeNull()
        const journal = journalOf(callId)!
        expect(journal.effectState).toBe('outcome_unknown')
        expect(journal.failureCode).toBe('provider_outcome_unknown')
    })

    it('settles a refused dial from its reply cause and reports no accepted effect', async () => {
        const { port } = makePort({
            originate: async () => { throw new EslOriginateRejectedError('-ERR USER_BUSY') },
        })
        const { callId } = aiCallCampaignLiveDialIdentity(LAUNCH_ID)

        const result = await port.dispatch(request())

        expect(result?.terminal.kind).toBe('retryable_failure')
        expect(result?.terminal.failureCode).toBe('provider_busy')
        expect(result?.providerAccepted).toBe(false)
        expect(journalOf(callId)!.effectState).toBe('rejected')
        expect(journalOf(callId)!.providerReplyExcerpt).toBe('-ERR USER_BUSY')
    })
})

// ── recovery ──────────────────────────────────────────────────────────────────

describe('crash recovery', () => {
    it('prepared: proves nothing was sent, settles retryable and calls no provider', async () => {
        const { port: first } = makePort({ originate: async () => { throw new Error('crash before network') } })
        await first.dispatch(request())
        const { callId } = aiCallCampaignLiveDialIdentity(LAUNCH_ID)
        // Force the journal back to `prepared`: the T2 commit never happened.
        const call = store.calls.get(callId)!
        const journal = journalOf(callId)!
        store.calls.set(callId, {
            ...call,
            metadata: { [AI_CALL_CAMPAIGN_LIVE_DIAL_METADATA_KEY]: { ...journal, effectState: 'prepared', dispatchStartedAt: null } },
        })

        const { port, originate } = makePort()
        const result = await port.reconcile(request())

        expect(originate).not.toHaveBeenCalled()
        expect(result?.terminal.kind).toBe('retryable_failure')
        expect(result?.terminal.failureCode).toBe('provider_not_started')
        expect(result?.providerAccepted).toBe(false)
    })

    it('dispatch_started: a second dispatch execution never originates again', async () => {
        const { port: firstPort } = makePort({
            originate: async () => { throw new EslOriginateOutcomeUnknownError('lost') },
        })
        await firstPort.dispatch(request())
        const { callId } = aiCallCampaignLiveDialIdentity(LAUNCH_ID)
        const call = store.calls.get(callId)!
        const journal = journalOf(callId)!
        store.calls.set(callId, {
            ...call,
            metadata: { [AI_CALL_CAMPAIGN_LIVE_DIAL_METADATA_KEY]: { ...journal, effectState: 'dispatch_started' } },
        })

        const { port, originate } = makePort()
        const dispatched = await port.dispatch(request())
        const reconciled = await port.reconcile(request())

        expect(originate).not.toHaveBeenCalled()
        expect(dispatched).toBeNull()
        expect(reconciled).toBeNull()
        expect(journalOf(callId)!.effectState).toBe('dispatch_started')
    })

    it('an accepted effect whose observation write fails still converges, and never re-dials', async () => {
        // The provider accepted; only saying so durably failed.
        const { port, originate } = makePort({
            originate: async () => { store.failNextCallUpdate = true; return 'provider-reference' },
        })
        const { callId } = aiCallCampaignLiveDialIdentity(LAUNCH_ID)

        expect(await port.dispatch(request())).toBeNull()
        expect(originate).toHaveBeenCalledTimes(1)
        // Unobserved, not lost: still pending, still forbidden to originate again.
        expect(journalOf(callId)!.effectState).toBe('outcome_unknown')
        expect(journalOf(callId)!.failureCode).toBe('provider_observation_failed')

        // A later cycle with the channel alive stays pending, then settles once the
        // Call carries a durable terminal fact.
        const alive = makePort({ channelExists: async () => true })
        expect(await alive.port.reconcile(request())).toBeNull()
        expect(alive.originate).not.toHaveBeenCalled()

        const call = store.calls.get(callId)!
        store.calls.set(callId, { ...call, status: 'completed', endedAt: clock, aiSessionStatus: 'ended', aiOutcome: 'qualified' })
        const settled = makePort({ channelExists: async () => false })
        const result = await settled.port.reconcile(request())
        expect(result?.terminal.kind).toBe('success')
        expect(result?.terminal.outcomeCode).toBe('qualified')
    })
})

// ── bounded lifetime ──────────────────────────────────────────────────────────

describe('bounded effect lifetime', () => {
    async function pendingCall(phase: 'dispatch_started' | 'outcome_unknown', extra: Record<string, unknown> = {}) {
        const { port } = makePort({ originate: async () => { throw new EslOriginateOutcomeUnknownError('lost') } })
        await port.dispatch(request())
        const { callId } = aiCallCampaignLiveDialIdentity(LAUNCH_ID)
        const call = store.calls.get(callId)!
        const journal = journalOf(callId)!
        store.calls.set(callId, {
            ...call,
            ...extra,
            metadata: { [AI_CALL_CAMPAIGN_LIVE_DIAL_METADATA_KEY]: { ...journal, effectState: phase } },
        })
        return callId
    }

    it('keeps an effect pending while FreeSWITCH still has the channel, past the horizon', async () => {
        await pendingCall('outcome_unknown')
        clock = new Date(clock.getTime() + CAMPAIGN_EFFECT_HORIZON_MS * 3)
        const { port, originate } = makePort({ channelExists: async () => true })

        expect(await port.reconcile(request())).toBeNull()
        expect(originate).not.toHaveBeenCalled()
    })

    it('cannot settle an indeterminate FreeSWITCH before the effect horizon', async () => {
        await pendingCall('dispatch_started')
        clock = new Date(clock.getTime() + CAMPAIGN_EFFECT_HORIZON_MS - 1)
        const { port } = makePort({ channelExists: async () => null })

        expect(await port.reconcile(request())).toBeNull()
    })

    it('settles as permanently unresolved once the horizon passes with no evidence', async () => {
        await pendingCall('outcome_unknown')
        clock = new Date(clock.getTime() + CAMPAIGN_EFFECT_HORIZON_MS + 1)
        const { port } = makePort({ channelExists: async () => false })

        const result = await port.reconcile(request())

        expect(result?.terminal.kind).toBe('permanent_failure')
        expect(result?.terminal.failureCode).toBe('provider_acceptance_unresolved')
    })

    it('an answered call extends the wait to answer + 600s + margin, past the generic horizon', async () => {
        // Answered late enough that its own deadline outlives the generic horizon:
        // the per-call bound is the stronger one and must win.
        const answeredAt = new Date(clock.getTime() + CAMPAIGN_EFFECT_HORIZON_MS - 60_000)
        await pendingCall('outcome_unknown', { answeredAt })
        const answeredDeadline = answeredAt.getTime()
            + CONTROLLED_REAL_CALL_MAX_ANSWERED_MS + EFFECT_OBSERVATION_MARGIN_MS
        expect(answeredDeadline).toBeGreaterThan(clock.getTime() + CAMPAIGN_EFFECT_HORIZON_MS)

        clock = new Date(answeredDeadline - 1)
        expect(await makePort({ channelExists: async () => false }).port.reconcile(request())).toBeNull()

        clock = new Date(answeredDeadline + 1)
        const result = await makePort({ channelExists: async () => false }).port.reconcile(request())
        expect(result?.terminal.kind).toBe('permanent_failure')
        expect(result?.terminal.failureCode).toBe('provider_acceptance_unresolved')
    })

    it('recognises RECOVERED_STALE_CHANNEL as a durable terminal fact', () => {
        expect(durableCallTerminalFact({
            id: 'c', fsUuid: 'f', status: 'ringing', startedAt: clock, answeredAt: null, endedAt: null,
            hangupCause: 'RECOVERED_STALE_CHANNEL', aiSessionStatus: null, aiOutcome: null,
            aiScenarioId: SCENARIO_REF, toNumber: '+79990000000', metadata: {},
        })).toBe(true)
    })

    it('does not read an absent channel as proof that no call happened', async () => {
        await pendingCall('dispatch_started')
        const { port } = makePort({ channelExists: async () => false })
        // Well inside the horizon: absence is not evidence.
        expect(await port.reconcile(request())).toBeNull()
    })
})

// ── bounds and constants ──────────────────────────────────────────────────────

describe('campaign dialing bounds', () => {
    it('carries the proven pre-answer ceiling on every originate', () => {
        const vars = aiCallCampaignLiveDialChannelVars('/var/lib/freeswitch/recordings/x.wav')
        expect(vars.originate_timeout).toBe('60')
        expect(Number(vars.originate_timeout) * 1_000).toBe(CAMPAIGN_MAX_PREANSWER_MS)
    })

    it('never expresses the ceiling with a variable that does not bound an originate', () => {
        const vars = aiCallCampaignLiveDialChannelVars('/var/lib/freeswitch/recordings/x.wav')
        for (const forbidden of CAMPAIGN_FORBIDDEN_PREANSWER_VARIABLES) {
            expect(Object.keys(vars)).not.toContain(forbidden)
        }
    })

    it('keeps the C1b answered cap as the only answered-duration literal', () => {
        const vars = aiCallCampaignLiveDialChannelVars('/var/lib/freeswitch/recordings/x.wav')
        expect(vars.execute_on_answer_yoko_ai_hard_limit)
            .toBe(`'sched_hangup +${CONTROLLED_REAL_CALL_MAX_ANSWERED_MS / 1_000} NORMAL_CLEARING'`)
        expect(vars.yoko_ai_max_answered_ms).toBe(String(CONTROLLED_REAL_CALL_MAX_ANSWERED_MS))
        expect(MAX_PHYSICAL_EFFECT_MS).toBe(CAMPAIGN_MAX_PREANSWER_MS + CONTROLLED_REAL_CALL_MAX_ANSWERED_MS)
    })

    it('ships a horizon at least as long as the derived minimum', () => {
        expect(MIN_CAMPAIGN_EFFECT_HORIZON_MS).toBe(Math.max(
            MAX_PHYSICAL_EFFECT_MS + EFFECT_OBSERVATION_MARGIN_MS,
            600_000 + 30_000 + EFFECT_OBSERVATION_MARGIN_MS,
        ))
        expect(CAMPAIGN_EFFECT_HORIZON_MS).toBeGreaterThanOrEqual(MIN_CAMPAIGN_EFFECT_HORIZON_MS)
    })

    it('clamps the occupancy poll cadence', () => {
        expect(campaignOccupancyRecheckMs()).toBe(1_000)
        expect(campaignOccupancyRecheckMs(1)).toBe(250)
        expect(campaignOccupancyRecheckMs(10 ** 9)).toBe(30_000)
    })
})

describe('provider rejection causes', () => {
    it.each([
        ['-ERR NO_ANSWER', 'retryable_failure', 'provider_no_answer'],
        ['-ERR USER_BUSY', 'retryable_failure', 'provider_busy'],
        ['-ERR NORMAL_TEMPORARY_FAILURE', 'retryable_failure', 'provider_unavailable'],
        ['-ERR GATEWAY_DOWN', 'retryable_failure', 'provider_unavailable'],
        ['-ERR UNALLOCATED_NUMBER', 'permanent_failure', 'provider_rejected'],
        ['-ERR SOMETHING_NEW', 'permanent_failure', 'provider_rejected'],
        [null, 'permanent_failure', 'provider_rejected'],
    ])('maps %s to %s', (excerpt, kind, failureCode) => {
        expect(classifyOriginateRejection(excerpt as string | null)).toEqual({ kind, failureCode })
    })

    it('carries the bounded cause on the rejection error itself', () => {
        expect(new EslOriginateRejectedError('-ERR NO_ANSWER').replyExcerpt).toBe('-ERR NO_ANSWER')
        expect(new EslOriginateRejectedError().replyExcerpt).toBeNull()
        expect(new EslOriginateRejectedError('x'.repeat(400)).replyExcerpt).toHaveLength(120)
        // Class and message are unchanged, which is all the controlled route checks.
        expect(new EslOriginateRejectedError('-ERR NO_ANSWER').message)
            .toBe('FreeSWITCH rejected the originate command')
    })
})

describe('settled call mapping', () => {
    const base = {
        id: 'c', fsUuid: 'f', startedAt: new Date(), answeredAt: null as Date | null, endedAt: new Date(),
        hangupCause: null as string | null, aiSessionStatus: null as string | null, aiOutcome: null as string | null,
        aiScenarioId: SCENARIO_REF, toNumber: '+79990000000', metadata: {},
    }

    it('maps a completed dialog to success with its outcome', () => {
        expect(campaignTerminalForSettledCall(LAUNCH_ID, { ...base, status: 'completed', aiSessionStatus: 'ended', aiOutcome: 'qualified' }))
            .toMatchObject({ kind: 'success', outcomeCode: 'qualified' })
    })

    it('maps no answer and busy to retryable facts', () => {
        expect(campaignTerminalForSettledCall(LAUNCH_ID, { ...base, status: 'no_answer' }))
            .toMatchObject({ kind: 'retryable_failure', failureCode: 'provider_no_answer' })
        expect(campaignTerminalForSettledCall(LAUNCH_ID, { ...base, status: 'busy' }))
            .toMatchObject({ kind: 'retryable_failure', failureCode: 'provider_busy' })
    })

    it('maps an AI runtime failure to a retryable fact', () => {
        expect(campaignTerminalForSettledCall(LAUNCH_ID, { ...base, status: 'failed', aiSessionStatus: 'failed' }))
            .toMatchObject({ kind: 'retryable_failure', failureCode: 'ai_runtime_failure' })
    })

    it('is stable: the same fact yields the same terminal event id', () => {
        const first = campaignTerminalForSettledCall(LAUNCH_ID, { ...base, status: 'no_answer' })
        const second = campaignTerminalForSettledCall(LAUNCH_ID, { ...base, status: 'no_answer' })
        expect(second.eventId).toBe(first.eventId)
    })
})

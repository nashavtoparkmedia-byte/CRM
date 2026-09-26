/**
 * The provider-effect phase of one Calling call, as a durable fact.
 *
 * Why this exists: a linked Call plus a dispatched campaign attempt does not say
 * whether a provider effect was ever attempted. Two crash windows look identical
 * afterwards — the process died before the originate was issued, or it died after
 * issuing it and before observing the reply — and a recovery that guesses they are
 * the same either abandons a live call or dials a lead twice.
 *
 * So the phase is written BEFORE the network write, monotonically, under a
 * compare-and-set on the previous phase. The helper is namespace-agnostic and holds
 * no provider, persistence or campaign semantics: the caller supplies the metadata
 * namespace, so the manual controlled route's own `controlledRealCallV1` structure
 * stays exactly as it is.
 */

export const PROVIDER_EFFECT_PHASES = [
    /** Deterministic Call exists and is linked. Nothing has been sent. */
    'prepared',
    /** Point of no return: from here this identity may never originate again. */
    'dispatch_started',
    /** A `+OK` reply was observed for this effect. */
    'accepted',
    /** A non-`+OK` reply was observed. The excerpt says whether a call was placed. */
    'rejected',
    /** The command left this process; its outcome was not observed. */
    'outcome_unknown',
] as const

export type ProviderEffectPhase = typeof PROVIDER_EFFECT_PHASES[number]

/** The phases a phase may legally move to. Terminal observations are final. */
const ALLOWED_TRANSITIONS: Record<ProviderEffectPhase, readonly ProviderEffectPhase[]> = {
    prepared: ['dispatch_started'],
    dispatch_started: ['accepted', 'rejected', 'outcome_unknown'],
    accepted: [],
    rejected: [],
    outcome_unknown: [],
}

export const PROVIDER_EFFECT_OBSERVED_PHASES: readonly ProviderEffectPhase[] = [
    'accepted', 'rejected', 'outcome_unknown',
]

export const PROVIDER_EFFECT_EXCERPT_LIMIT = 120

export interface ProviderEffectJournalV1 {
    version: 1
    effectState: ProviderEffectPhase
    launchId: string
    campaignId: string
    memberId: string
    attemptNumber: number
    scenarioFingerprint: string
    requestFingerprint: string
    preparedAt: string
    dispatchStartedAt: string | null
    observedAt: string | null
    providerReference: string | null
    providerReplyExcerpt: string | null
    failureCode: string | null
    creatorId: string | null
}

export class ProviderEffectPhaseError extends Error {
    constructor(readonly code: string) {
        super(code)
        this.name = 'ProviderEffectPhaseError'
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bounded(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value.slice(0, PROVIDER_EFFECT_EXCERPT_LIMIT) : null
}

export function isProviderEffectPhase(value: unknown): value is ProviderEffectPhase {
    return typeof value === 'string' && (PROVIDER_EFFECT_PHASES as readonly string[]).includes(value)
}

/** Reads the journal out of a Call metadata blob. Unreadable shapes are `null`. */
export function readProviderEffectJournal(
    metadata: unknown,
    namespace: string,
): ProviderEffectJournalV1 | null {
    if (!isRecord(metadata)) return null
    const journal = metadata[namespace]
    if (!isRecord(journal) || journal.version !== 1 || !isProviderEffectPhase(journal.effectState)) return null
    return {
        version: 1,
        effectState: journal.effectState,
        launchId: String(journal.launchId ?? ''),
        campaignId: String(journal.campaignId ?? ''),
        memberId: String(journal.memberId ?? ''),
        attemptNumber: Number(journal.attemptNumber ?? 0),
        scenarioFingerprint: String(journal.scenarioFingerprint ?? ''),
        requestFingerprint: String(journal.requestFingerprint ?? ''),
        preparedAt: String(journal.preparedAt ?? ''),
        dispatchStartedAt: typeof journal.dispatchStartedAt === 'string' ? journal.dispatchStartedAt : null,
        observedAt: typeof journal.observedAt === 'string' ? journal.observedAt : null,
        providerReference: bounded(journal.providerReference),
        providerReplyExcerpt: bounded(journal.providerReplyExcerpt),
        failureCode: bounded(journal.failureCode),
        creatorId: typeof journal.creatorId === 'string' ? journal.creatorId : null,
    }
}

/** True when this call may still issue its one provider effect. */
export function mayInitiateProviderEffect(journal: ProviderEffectJournalV1 | null): boolean {
    return journal?.effectState === 'prepared'
}

/** True when a provider effect may exist and its outcome is not observed yet. */
export function providerEffectOutcomePending(journal: ProviderEffectJournalV1 | null): boolean {
    return journal?.effectState === 'dispatch_started' || journal?.effectState === 'outcome_unknown'
}

export function assertProviderEffectTransition(
    from: ProviderEffectPhase,
    to: ProviderEffectPhase,
): void {
    if (from === to) throw new ProviderEffectPhaseError('provider_effect_phase_repeated')
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
        throw new ProviderEffectPhaseError(`provider_effect_phase_illegal:${from}->${to}`)
    }
}

/**
 * The journal a freshly prepared effect starts with. Written inside the same
 * transaction that creates the Call and links the attempt, never later.
 */
export function initialProviderEffectJournal(input: {
    launchId: string
    campaignId: string
    memberId: string
    attemptNumber: number
    scenarioFingerprint: string
    requestFingerprint: string
    preparedAt: Date
    creatorId?: string | null
}): ProviderEffectJournalV1 {
    return {
        version: 1,
        effectState: 'prepared',
        launchId: input.launchId,
        campaignId: input.campaignId,
        memberId: input.memberId,
        attemptNumber: input.attemptNumber,
        scenarioFingerprint: input.scenarioFingerprint,
        requestFingerprint: input.requestFingerprint,
        preparedAt: input.preparedAt.toISOString(),
        dispatchStartedAt: null,
        observedAt: null,
        providerReference: null,
        providerReplyExcerpt: null,
        failureCode: null,
        creatorId: input.creatorId ?? null,
    }
}

/**
 * The next journal for a legal transition. Pure: the caller performs the write
 * under a compare-and-set on `effectState`, so a late duplicate observation can
 * never regress a phase.
 */
export function advancedProviderEffectJournal(
    journal: ProviderEffectJournalV1,
    to: ProviderEffectPhase,
    at: Date,
    observation?: {
        providerReference?: string | null
        providerReplyExcerpt?: string | null
        failureCode?: string | null
    },
): ProviderEffectJournalV1 {
    assertProviderEffectTransition(journal.effectState, to)
    return {
        ...journal,
        effectState: to,
        dispatchStartedAt: to === 'dispatch_started' ? at.toISOString() : journal.dispatchStartedAt,
        observedAt: PROVIDER_EFFECT_OBSERVED_PHASES.includes(to) ? at.toISOString() : journal.observedAt,
        providerReference: bounded(observation?.providerReference) ?? journal.providerReference,
        providerReplyExcerpt: bounded(observation?.providerReplyExcerpt) ?? journal.providerReplyExcerpt,
        failureCode: bounded(observation?.failureCode) ?? journal.failureCode,
    }
}

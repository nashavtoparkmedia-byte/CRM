import { createHash } from 'node:crypto'
import { CONTROLLED_REAL_CALL_MAX_ANSWERED_MS } from './controlled-real-ai-call'

/**
 * Campaign live dialing — the Calling-owned facts one automatic campaign call is
 * bounded by, and the deterministic identities it is addressed with.
 *
 * Everything here is pure. It holds no provider, no persistence and no runtime
 * selection, so a campaign adapter and a test can share exactly the same numbers
 * and the same identity derivation.
 */

/**
 * The pre-answer ceiling a campaign originate carries.
 *
 * Measured on the pinned FreeSWITCH 1.10.12 image: an `api originate` with no
 * timeout variable gives up after ~60 s with `-ERR NO_ANSWER`, `originate_timeout`
 * moves that deadline exactly, `call_timeout` in the originate variable block is
 * IGNORED (it only works as a dialplan `set` before `bridge`, which is how the
 * inbound ring group uses it), and `leg_timeout` bounds the attempt but reports
 * `ALLOTTED_TIMEOUT` with per-leg bridge semantics. The measurement also showed the
 * ceiling stops at answer: a call answered at 3.2 s under `originate_timeout=5`
 * stayed up well past 5 s.
 *
 * So this constant pins the behaviour the runtime already has rather than choosing
 * a new product policy, and it removes the dependency on an unpinned default.
 */
export const CAMPAIGN_MAX_PREANSWER_MS = 60_000

/** The only FreeSWITCH variable proven to move the pre-answer deadline. */
export const CAMPAIGN_PREANSWER_CHANNEL_VARIABLE = 'originate_timeout' as const

/** Variables that look like the ceiling and are not it. Never used for this policy. */
export const CAMPAIGN_FORBIDDEN_PREANSWER_VARIABLES = ['call_timeout', 'leg_timeout'] as const

/**
 * The longest a campaign telephone effect can physically live: the pre-answer
 * ceiling above plus C1b's answered cap, which FreeSWITCH enforces itself through
 * the pre-answer `sched_hangup` hook. Sequential phases of one channel, so the two
 * terms add. The answered term is imported, never re-declared.
 */
export const MAX_PHYSICAL_EFFECT_MS = CAMPAIGN_MAX_PREANSWER_MS + CONTROLLED_REAL_CALL_MAX_ANSWERED_MS

/**
 * Head-room for evidence to arrive: ESL event delivery, the 30 s stale-call
 * reconcile cadence and clock skew.
 */
export const EFFECT_OBSERVATION_MARGIN_MS = 120_000

/**
 * The smallest horizon that is safe, derived from repository-owned facts rather
 * than chosen. Two independent evidence windows, so a maximum and not a sum:
 * a channel can still be legally alive until the physical bound, and the stale-call
 * repair can still write a durable terminal fact until its lookback plus one cycle.
 */
/**
 * The stale-call repair's own evidence window, mirrored.
 *
 * The authority is `STALE_CALL_RECONCILE_LOOKBACK_MS_V1` /
 * `STALE_CALL_RECONCILE_INTERVAL_MS_V1` in the FreeSWITCH client, but this module is
 * reachable from the Calling public facade and therefore may not import a provider
 * implementation. So the two numbers are restated here as Calling-owned facts and a
 * test asserts they still equal the exported ones — a drift fails the build instead
 * of silently shortening the horizon.
 */
export const MIRRORED_STALE_CALL_LOOKBACK_MS = 600_000
export const MIRRORED_STALE_CALL_RECONCILE_INTERVAL_MS = 30_000

export const MIN_CAMPAIGN_EFFECT_HORIZON_MS = Math.max(
    MAX_PHYSICAL_EFFECT_MS + EFFECT_OBSERVATION_MARGIN_MS,
    MIRRORED_STALE_CALL_LOOKBACK_MS + MIRRORED_STALE_CALL_RECONCILE_INTERVAL_MS + EFFECT_OBSERVATION_MARGIN_MS,
)

/**
 * The shipped horizon. Asserted at module load against the computed minimum, so a
 * later change to the pre-answer ceiling, the answered cap or the stale-call
 * windows cannot silently leave it too short.
 */
export const CAMPAIGN_EFFECT_HORIZON_MS = 15 * 60 * 1_000

if (CAMPAIGN_EFFECT_HORIZON_MS < MIN_CAMPAIGN_EFFECT_HORIZON_MS) {
    throw new Error(
        `AI_CALL_CAMPAIGN_EFFECT_HORIZON_TOO_SHORT:${CAMPAIGN_EFFECT_HORIZON_MS}<${MIN_CAMPAIGN_EFFECT_HORIZON_MS}`,
    )
}

/** Poll cadence for an admission blocked by durable live-effect occupancy. */
export const OCCUPANCY_RECHECK_MS = 1_000
export const MIN_OCCUPANCY_RECHECK_MS = 250
export const MAX_OCCUPANCY_RECHECK_MS = 30_000

export function campaignOccupancyRecheckMs(value: number = OCCUPANCY_RECHECK_MS): number {
    if (!Number.isFinite(value)) return OCCUPANCY_RECHECK_MS
    return Math.min(MAX_OCCUPANCY_RECHECK_MS, Math.max(MIN_OCCUPANCY_RECHECK_MS, Math.trunc(value)))
}

const LAUNCH_ID = /^ai-call-launch:v1:[0-9a-f]{64}$/

function digest(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex')
}

export class AiCallCampaignLiveDialInputError extends Error {
    constructor(readonly code: string) {
        super(code)
        this.name = 'AiCallCampaignLiveDialInputError'
    }
}

/**
 * The deterministic Calling identities one campaign launch is addressed with.
 *
 * Campaign-namespaced on purpose: the manual controlled route derives its identity
 * from an operator-approved requestId, validates it as `[A-Za-z0-9_-]{16,128}`, and
 * carries one-shot admission semantics — a `launchId` is neither shaped like that
 * nor governed by it. Same launch always yields the same Call id and the same
 * fsUuid; a different attempt number is a different launchId and therefore a
 * different effect.
 */
export function aiCallCampaignLiveDialIdentity(launchId: string): { callId: string; fsUuid: string } {
    if (!LAUNCH_ID.test(launchId)) throw new AiCallCampaignLiveDialInputError('launch_id_invalid')
    const callDigest = digest(`ai-call-campaign-live-dial:v1\0${launchId}`)
    const fsDigest = digest(`ai-call-campaign-live-dial-fs:v1\0${launchId}`)
    return {
        callId: `campaign_live_${callDigest.slice(0, 32)}`,
        fsUuid: [
            fsDigest.slice(0, 8),
            fsDigest.slice(8, 12),
            `4${fsDigest.slice(13, 16)}`,
            `a${fsDigest.slice(17, 20)}`,
            fsDigest.slice(20, 32),
        ].join('-'),
    }
}

/** Binds the Call row to the exact launch payload it was created for. */
export function aiCallCampaignLiveDialFingerprint(input: {
    launchId: string
    campaignId: string
    memberId: string
    attemptNumber: number
    phoneE164: string
    scenarioRef: string
    scenarioFingerprint: string
}): string {
    return digest(JSON.stringify(input))
}

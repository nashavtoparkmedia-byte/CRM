import type { CallAlertKindV1 } from '@/contracts/calling/v1'

/**
 * Which alert, if any, a change of call state warrants.
 *
 * Deliberately a function of the transition rather than of a call site. `missed`
 * is reached from more than one place - the hangup handler and the stale-channel
 * reconciliation sweep - so hanging the alert off either one would miss calls
 * that arrived through the other. Every path that moves a call's state asks this
 * instead, and the answer is the same wherever it is asked.
 *
 * Calling is the authority here. Nothing infers "missed" from a timer, from a
 * device's silence, or from the absence of an answer event elsewhere.
 */

export interface CallStateSnapshotV1 {
    direction: 'inbound' | 'outbound'
    status: string
    isSimulation: boolean
}

export interface CallAlertTransitionV1 {
    /** The state before, or null when the call row is coming into existence. */
    before: CallStateSnapshotV1 | null
    after: CallStateSnapshotV1
}

export function callAlertKindForTransitionV1(transition: CallAlertTransitionV1): CallAlertKindV1 | null {
    const { before, after } = transition

    // Outbound calls never alert: the operator started them and is already there.
    if (after.direction !== 'inbound') return null

    // Controlled proof rows are excluded from ordinary call history and analytics,
    // so they must not ring a real operator's phone either.
    if (after.isSimulation) return null

    // A real inbound call coming into existence, ringing.
    if (before === null && after.status === 'ringing') return 'call_incoming'

    // The domain's terminal statement that an inbound call was never answered.
    // Guarded on the transition, so re-persisting an already-missed call is not a
    // second alert, and the event identity would collapse it even if it were.
    if (before !== null && before.status !== 'missed' && after.status === 'missed') return 'call_missed'

    return null
}

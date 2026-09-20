'use server'

import { revalidatePath } from 'next/cache'

import { compensationManagerActionV1 } from '@/modules/fleet-operations/public/v1'

import { managerEvidence, managerSession } from './manager-data'

/**
 * The manager's monetary actions.
 *
 * No action takes a principal from the browser: the acting manager is resolved
 * from the session on every call, so a crafted form post cannot put someone
 * else's name on a payout. No action reports success the backend did not
 * confirm either: the answer is the result code and the state storage holds
 * afterwards, and the page is revalidated so the screen re-reads it.
 */

export type ManagerActionName =
    | 'approve'
    | 'reject'
    | 'mark_paid'
    | 'cancel_approval'
    | 'declare_outcome_unknown'
    | 'reconcile_paid'
    | 'reconcile_not_paid'

export interface ManagerActionResponse {
    code: string
    state: string | null
}

export async function runCompensationManagerAction(input: {
    applicationId: string
    action: ManagerActionName
    reason?: string
}): Promise<ManagerActionResponse> {
    const session = await managerSession()
    if (!session.ok) return { code: session.refusal, state: null }

    // Approving is the only action the screenshot gates, and metadata is not
    // proof: the file is fetched now, and a failure fails the approval closed.
    // Every other action stays available, because a Telegram outage must not
    // strand money that is already authorised.
    let evidenceProven = false
    if (input.action === 'approve') {
        const evidence = await managerEvidence(input.applicationId)
        if (!evidence.ok) {
            return { code: evidence.reason === 'missing' ? 'evidence_missing' : 'evidence_unavailable', state: null }
        }
        evidenceProven = true
    }

    const result = await compensationManagerActionV1({
        applicationId: input.applicationId,
        action: input.action,
        reason: typeof input.reason === 'string' ? input.reason : null,
        principal: session.principal,
        evidenceProven,
    })

    revalidatePath('/compensation')
    revalidatePath(`/compensation/${input.applicationId}`)
    return { code: result.code, state: result.state }
}

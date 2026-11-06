'use server'

import { revalidatePath } from 'next/cache'

import {
    cashAccessManagerGrantV1,
    cashAccessManagerRevokeV1,
    cashReferralManagerPersonV1,
    cashReferralManagerRecordInvitationV1,
    cashReferralManagerSearchV1,
    cashReferralManagerWithdrawInvitationV1,
} from '@/modules/fleet-operations/public/v1'

import { managerSession } from '../manager-data'
import { candidateView, personView, resolveCashStaffAuthorityV1 } from './referral-data'
import type { ReferralPersonResponse, ReferralSearchResponse, ReferralWriteResponse } from './view'

/**
 * The referral screens' server actions.
 *
 * Reads need the same CRM manager session as the rest of /compensation.
 * Writes need that and a signed staff session besides; no action takes a
 * principal, a role or a capability from the browser. Every write answers
 * with the backend's own code, never a success it did not confirm.
 */

const PATH = '/compensation/referrals'

export async function searchReferralPeople(query: string): Promise<ReferralSearchResponse> {
    const session = await managerSession()
    if (!session.ok) return { status: 'refused', reason: session.refusal }
    const result = await cashReferralManagerSearchV1(query)
    if (result.status !== 'ok') return { status: 'refused', reason: result.status === 'disabled' ? 'disabled' : result.reason }
    return { status: 'ok', candidates: result.candidates.map(candidateView), truncated: result.truncated }
}

export async function loadReferralPerson(contactId: string): Promise<ReferralPersonResponse> {
    const session = await managerSession()
    if (!session.ok) return { status: 'refused', reason: session.refusal }
    const result = await cashReferralManagerPersonV1(contactId)
    if (result.status !== 'ok') return { status: 'refused', reason: result.status }
    return { status: 'ok', person: personView(result.card) }
}

async function writer(): Promise<{ ok: true; authority: Parameters<typeof cashAccessManagerGrantV1>[0]['authority'] } | { ok: false; response: ReferralWriteResponse }> {
    const session = await managerSession()
    if (!session.ok) return { ok: false, response: { status: 'refused', reason: session.refusal } }
    const staff = await resolveCashStaffAuthorityV1()
    if (!staff.ok) return { ok: false, response: { status: 'refused', reason: staff.refusal } }
    return { ok: true, authority: staff.authority }
}

export async function recordReferralInvitation(input: {
    inviterContactId: string
    inviteeContactId: string
    comment: string
    requestId: string
}): Promise<ReferralWriteResponse> {
    const acting = await writer()
    if (!acting.ok) return acting.response
    const result = await cashReferralManagerRecordInvitationV1({ ...input, authority: acting.authority })
    revalidatePath(PATH)
    if (result.status === 'disabled') return { status: 'refused', reason: 'disabled' }
    if (result.status === 'refused') {
        return { status: 'refused', reason: result.reason, detail: 'inviterName' in result ? result.inviterName : null }
    }
    return { status: 'done', code: result.status, attributionId: result.attributionId }
}

export async function withdrawReferralInvitation(input: {
    attributionId: string
    expectedVersion: number
    comment: string
    requestId: string
}): Promise<ReferralWriteResponse> {
    const acting = await writer()
    if (!acting.ok) return acting.response
    const result = await cashReferralManagerWithdrawInvitationV1({ ...input, authority: acting.authority })
    revalidatePath(PATH)
    if (result.status === 'disabled') return { status: 'refused', reason: 'disabled' }
    if (result.status === 'refused') return { status: 'refused', reason: result.reason }
    return { status: 'done', code: result.status }
}

export async function grantCashAccess(input: {
    contactId: string
    basis: string
    referralAttributionId: string | null
    comment: string
    requestId: string
}): Promise<ReferralWriteResponse> {
    const acting = await writer()
    if (!acting.ok) return acting.response
    const result = await cashAccessManagerGrantV1({ ...input, authority: acting.authority })
    revalidatePath(PATH)
    if (result.status === 'disabled') return { status: 'refused', reason: 'disabled' }
    if (result.status === 'refused') return { status: 'refused', reason: result.reason }
    return { status: 'done', code: result.status }
}

export async function revokeCashAccess(input: {
    contactId: string
    comment: string
    requestId: string
}): Promise<ReferralWriteResponse> {
    const acting = await writer()
    if (!acting.ok) return acting.response
    const result = await cashAccessManagerRevokeV1({ ...input, authority: acting.authority })
    revalidatePath(PATH)
    if (result.status === 'disabled') return { status: 'refused', reason: 'disabled' }
    if (result.status === 'refused') return { status: 'refused', reason: result.reason }
    return { status: 'done', code: result.status }
}

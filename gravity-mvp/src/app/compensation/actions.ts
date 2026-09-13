'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'

import {
    compensationManagerActionV1,
    compensationManagerApplicationsV1,
} from '@/modules/fleet-operations/application/compensation-pilot-operations'
import { resolveManagerPrincipalV1 } from '@/modules/fleet-operations/public/v1/compensation-manager-principal'
import { CURRENT_USER_QUERY_V1 } from '@/contracts/identity-access/v1'
import { queryCurrentUserV1 } from '@/modules/identity-access/public/v1/identity-actions'

export interface CompensationApplicationView {
    applicationId: string
    status: string
    canonicalContactId: string
    externalParkId: string
    externalOrderId: string
    shortOrderId: string | null
    telegramUserId: string | null
    attachmentFileId: string | null
    attachmentKind: string | null
    supportContactedAt: string | null
    requestedKopecks: number
    verifiedKopecks: number
    payableKopecks: number
    submittedAt: string
    rejectionReason: string | null
    hasLiveAuthorization: boolean
    hasOpenReconciliation: boolean
}

/**
 * The manager list, under the existing CRM access model.
 */
export async function listCompensationApplications(): Promise<CompensationApplicationView[]> {
    const rows = await compensationManagerApplicationsV1()
    return rows.map((row) => ({
        applicationId: row.applicationId,
        status: row.status,
        canonicalContactId: row.canonicalContactId,
        externalParkId: row.externalParkId,
        externalOrderId: row.externalOrderId,
        shortOrderId: row.shortOrderIdDisplay,
        telegramUserId: row.telegramUserId,
        attachmentFileId: row.attachmentFileId,
        attachmentKind: row.attachmentKind,
        supportContactedAt: row.supportContactedAt ? row.supportContactedAt.toISOString() : null,
        requestedKopecks: row.claimedKopecks,
        verifiedKopecks: row.verifiedKopecks,
        payableKopecks: row.amountKopecks,
        submittedAt: row.submittedAt.toISOString(),
        rejectionReason: row.rejectionReason,
        hasLiveAuthorization: row.hasLiveAuthorization,
        hasOpenReconciliation: row.hasOpenReconciliation,
    }))
}

export interface ManagerActionResult {
    ok: boolean
    operation?: string
    refusal?: string
}

/**
 * Resolves who is acting from the session cookie the CRM already issues.
 *
 * No action below takes a principal as an argument, so a crafted form post
 * cannot choose whose name ends up on a payout. An unproven session returns a
 * refusal and every caller stops before touching monetary state.
 */
async function actingPrincipal() {
    const result = await queryCurrentUserV1({ contract: CURRENT_USER_QUERY_V1 })
    return resolveManagerPrincipalV1((result as { user: unknown }).user as never)
}

/**
 * Approve: takes the C1 payout authorization, attributed to the signed-in
 * manager. The money is still paid by hand afterwards.
 */
export async function approveCompensationApplication(
    applicationId: string,
): Promise<ManagerActionResult> {
    const acting = await actingPrincipal()
    if (!acting.resolved) return { ok: false, refusal: acting.refusal }

    const outcome = await compensationManagerActionV1({
        applicationId,
        action: 'approve',
        principalId: acting.principal.principalId,
        operatorLabel: acting.principal.operatorLabel,
    })
    revalidatePath('/compensation')
    return outcome.performed
        ? { ok: true, operation: outcome.operation }
        : { ok: false, refusal: outcome.refusal }
}

export async function rejectCompensationApplication(
    applicationId: string,
    reason: string,
): Promise<ManagerActionResult> {
    const acting = await actingPrincipal()
    if (!acting.resolved) return { ok: false, refusal: acting.refusal }

    const outcome = await compensationManagerActionV1({
        applicationId,
        action: 'reject',
        principalId: acting.principal.principalId,
        operatorLabel: acting.principal.operatorLabel,
        reason,
        // A fresh key per attempt; a repeat of the same rejection is harmless.
        rejectionKey: randomUUID(),
    })
    revalidatePath('/compensation')
    return outcome.performed
        ? { ok: true, operation: outcome.operation }
        : { ok: false, refusal: outcome.refusal }
}

/**
 * Mark paid, after the manager has actually paid. Routes to finalize normally,
 * and to reconciliation when C1 lost sight of the outcome.
 */
export async function markCompensationApplicationPaid(
    applicationId: string,
): Promise<ManagerActionResult> {
    const acting = await actingPrincipal()
    if (!acting.resolved) return { ok: false, refusal: acting.refusal }

    const outcome = await compensationManagerActionV1({
        applicationId,
        action: 'mark_paid',
        principalId: acting.principal.principalId,
        operatorLabel: acting.principal.operatorLabel,
    })
    revalidatePath('/compensation')
    return outcome.performed
        ? { ok: true, operation: outcome.operation }
        : { ok: false, refusal: outcome.refusal }
}

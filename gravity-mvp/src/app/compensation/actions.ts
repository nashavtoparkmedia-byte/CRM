'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'

import {
    compensationManagerActionV1,
    compensationManagerApplicationsV1,
} from '@/modules/fleet-operations/application/compensation-pilot-operations'

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
 * The manager list. The screen renders these rows and decides nothing: which
 * buttons are live follows from the flags, which the service derived.
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
 * Approve: takes the C1 payout authorization. The money is still paid by hand
 * afterwards; this records that a manager authorised it.
 */
export async function approveCompensationApplication(
    applicationId: string,
    managerId: string,
    managerLabel: string | null,
): Promise<ManagerActionResult> {
    const outcome = await compensationManagerActionV1({
        applicationId, action: 'approve', principalId: managerId, operatorLabel: managerLabel,
    })
    revalidatePath('/compensation')
    return outcome.performed
        ? { ok: true, operation: outcome.operation }
        : { ok: false, refusal: outcome.refusal }
}

export async function rejectCompensationApplication(
    applicationId: string,
    managerId: string,
    managerLabel: string | null,
    reason: string,
): Promise<ManagerActionResult> {
    const outcome = await compensationManagerActionV1({
        applicationId,
        action: 'reject',
        principalId: managerId,
        operatorLabel: managerLabel,
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
    managerId: string,
    managerLabel: string | null,
): Promise<ManagerActionResult> {
    const outcome = await compensationManagerActionV1({
        applicationId, action: 'mark_paid', principalId: managerId, operatorLabel: managerLabel,
    })
    revalidatePath('/compensation')
    return outcome.performed
        ? { ok: true, operation: outcome.operation }
        : { ok: false, refusal: outcome.refusal }
}

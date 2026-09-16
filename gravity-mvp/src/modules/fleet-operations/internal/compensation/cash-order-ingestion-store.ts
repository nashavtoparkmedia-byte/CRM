/**
 * Persistence port for cash-order ingestion.
 *
 * Every trigger writes the catalogue through `writePage`, and nothing else in
 * the runtime writes `CompensationCashOrder`. A page write is one transaction
 * that proves and renews the park lease first, so a holder whose lease was
 * taken over rolls back before it can touch an order, and it advances
 * freshness or reconciliation progress only in the same commit as the page
 * those values describe.
 */

import type { CashOrderAuthoritySnapshotV1 } from './cash-order-park-authority'
import { compensationDerivedIdV1 } from './compensation-identity'

export const CASH_ORDER_PROVIDER_V1 = 'yandex_fleet' as const

export function cashOrderCheckpointIdV1(provider: string, externalParkId: string): string {
    return compensationDerivedIdV1('comp_cash_order_checkpoint', provider, externalParkId)
}

/** Freshness and reconciliation columns. They move only inside a page write. */
export interface CashOrderIngestionProgressV1 {
    lastHotSuccessAt: Date | null
    reconciliationPassStartedAt: Date | null
    reconciliationFloorBookedAt: Date | null
    reconciliationCursorBookedAt: Date | null
    lastReconciliationCompletedAt: Date | null
}

export interface CashOrderCheckpointV1 extends CashOrderIngestionProgressV1 {
    id: string
    provider: string
    externalParkId: string
    leaseToken: string | null
    leaseExpiresAt: Date | null
    lastRunMode: string | null
    lastRunStatus: string | null
    lastRunStartedAt: Date | null
    lastRunFinishedAt: Date | null
    consecutiveFailures: number
    lastErrorCode: string | null
    lastErrorSummary: string | null
    lastApiConnectionId: string | null
    lastRunSummary: Record<string, unknown> | null
    providerRetryNotBefore: Date | null
    providerRetryConnectionId: string | null
}

export interface CashOrderAcceptedRowV1 {
    /** `cashOrderRowIdV1` of the provider identity. */
    id: string
    externalOrderId: string
    shortOrderIdDisplay: string | null
    externalDriverProfileId: string
    rawPrice: string
    amountKopecks: number
    endedAt: Date
    providerBookedAt: Date | null
}

export interface CashOrderPageWriteV1 {
    checkpointId: string
    leaseToken: string
    provider: string
    externalParkId: string
    sourceConnectionId: string
    accepted: readonly CashOrderAcceptedRowV1[]
    removedOrderIds: readonly string[]
    /** Final page of a slice only: compare-and-set against the values read at acquisition. */
    progress: { expected: CashOrderIngestionProgressV1; next: CashOrderIngestionProgressV1 } | null
}

export interface CashOrderPageWriteResultV1 {
    inserted: number
    updated: number
    /** Accepted rows whose stored observation was newer, and removals that matched nothing. */
    guardedNoops: number
    removed: number
    driverReassigned: number
    amountChanged: number
    endedAtChanged: number
    /** The transaction time stamped as observedAt on every accepted row. */
    observedAt: Date
}

/** The lease was taken over or expired: the page rolled back and nothing was written. */
export class CashOrderLeaseLostError extends Error {
    constructor() {
        super('cash-order ingestion lease lost')
        this.name = 'CashOrderLeaseLostError'
    }
}

/** Progress no longer holds the value the holder planned from: the page rolled back. */
export class CashOrderProgressConflictError extends Error {
    constructor() {
        super('cash-order ingestion progress changed under the lease')
        this.name = 'CashOrderProgressConflictError'
    }
}

export type CashOrderLeaseAcquisitionV1 =
    | { acquired: true; dbNow: Date; checkpoint: CashOrderCheckpointV1 }
    | { acquired: false; dbNow: Date }

export interface CashOrderBackgroundFinishV1 {
    provider: string
    externalParkId: string
    /** The token this tick held, if any. A different live lease blocks the write. */
    leaseToken: string | null
    mode: 'dry_run' | 'write'
    status: 'succeeded' | 'failed'
    startedAt: Date
    errorCode: string | null
    errorSummary: string | null
    apiConnectionId: string | null
    summary: Record<string, unknown>
}

export interface CashOrderIngestionStoreV1 {
    /** Active parks and active links, metadata only, with the database time. */
    readAuthoritySnapshot(): Promise<{ dbNow: Date; snapshot: CashOrderAuthoritySnapshotV1 }>
    readCheckpoints(provider: string, externalParkIds: readonly string[]): Promise<{ dbNow: Date; checkpoints: CashOrderCheckpointV1[] }>
    acquireLease(input: { provider: string; externalParkId: string; token: string }): Promise<CashOrderLeaseAcquisitionV1>
    releaseLease(input: { checkpointId: string; token: string }): Promise<void>
    writePage(write: CashOrderPageWriteV1): Promise<CashOrderPageWriteResultV1>
    /** Lease-fenced. Returns the stored not-before time, or null when the lease was lost. */
    recordDeferral(input: { checkpointId: string; token: string; seconds: number; connectionId: string }): Promise<Date | null>
    /** Background ticks only. Returns false when another live lease holder blocked it. */
    finishBackgroundRun(input: CashOrderBackgroundFinishV1): Promise<boolean>
    /** Replaces one key of lastRunSummary and nothing else. */
    recordTargetedSummary(input: { provider: string; externalParkId: string; summary: Record<string, unknown> }): Promise<void>
    /** Lease-fenced dry-run progress under lastRunSummary.dryRun. */
    recordDryRunProgress(input: { checkpointId: string; token: string; dryRun: Record<string, unknown> }): Promise<boolean>
}

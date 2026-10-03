/**
 * The persistence capability the read-only cash-order preflight is given.
 *
 * The preflight reuses the authoritative ingestion slice, and that slice takes
 * a full ingestion store because in write mode it persists pages. A preflight
 * must never persist anything, so instead of trusting the slice's own mode
 * branch we hand it a store that *cannot* write: every mutating method throws
 * before it can reach a transaction.
 *
 * That makes the safety invariant structural rather than a matter of review. If
 * a future change re-introduces a write on the preflight path — a lease, a
 * checkpoint, a progress note, a deferral — it fails loudly on the first call,
 * with the method name, and no row has been touched. The negative test in
 * cash-order-ingestion-preflight.test.ts asserts exactly that.
 *
 * The read side is deliberately one method. Everything the preflight needs from
 * the database is the authority snapshot, which already carries the
 * database's own clock, so the preflight never needs a checkpoint read and is
 * given no way to perform one.
 */

import type {
    CashOrderIngestionStoreV1,
    CashOrderLeaseAcquisitionV1,
    CashOrderPageWriteResultV1,
    CashOrderCheckpointV1,
} from './cash-order-ingestion-store'
import type { CashOrderAuthoritySnapshotV1 } from './cash-order-park-authority'

/** The whole persistence capability a preflight is allowed to hold. */
export interface CashOrderPreflightReaderV1 {
    readAuthoritySnapshot(): Promise<{ dbNow: Date; snapshot: CashOrderAuthoritySnapshotV1 }>
}

/** Raised instead of performing any persistence the preflight asked for. */
export class CashOrderPreflightWriteAttemptV1 extends Error {
    constructor(readonly method: string) {
        super(`cash-order preflight attempted persistence: ${method}`)
        this.name = 'CashOrderPreflightWriteAttemptV1'
    }
}

/**
 * Wraps the narrow reader in the full store shape the slice expects. Reads that
 * the preflight does not need are refused alongside the writes, so the capability
 * cannot widen quietly either.
 */
export function readOnlyCashOrderIngestionStoreV1(
    reader: CashOrderPreflightReaderV1,
): CashOrderIngestionStoreV1 {
    const refuse = (method: string): never => {
        throw new CashOrderPreflightWriteAttemptV1(method)
    }
    return {
        async readAuthoritySnapshot() {
            return reader.readAuthoritySnapshot()
        },
        async readDatabaseNow(): Promise<Date> {
            return refuse('readDatabaseNow')
        },
        async readCheckpoints(): Promise<{ dbNow: Date; checkpoints: CashOrderCheckpointV1[] }> {
            return refuse('readCheckpoints')
        },
        async acquireLease(): Promise<CashOrderLeaseAcquisitionV1> {
            return refuse('acquireLease')
        },
        async releaseLease(): Promise<void> {
            return refuse('releaseLease')
        },
        async writePage(): Promise<CashOrderPageWriteResultV1> {
            return refuse('writePage')
        },
        async recordDeferral(): Promise<Date | null> {
            return refuse('recordDeferral')
        },
        async finishBackgroundRun(): Promise<boolean> {
            return refuse('finishBackgroundRun')
        },
        async recordTargetedSummary(): Promise<void> {
            return refuse('recordTargetedSummary')
        },
        async recordDryRunProgress(): Promise<boolean> {
            return refuse('recordDryRunProgress')
        },
    }
}

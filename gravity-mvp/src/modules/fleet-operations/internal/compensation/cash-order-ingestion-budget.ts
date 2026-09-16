/**
 * Time budgets for cash-order ingestion.
 *
 * Every provider request and every sleep is admitted against a monotonic
 * deadline before it starts, and the admission leaves room for one bounded
 * page write, the park finish and a margin. A slow or throttling provider can
 * therefore end its own park early, but it can never run a park past its
 * budget or the tick past its deadline.
 *
 * Wall-clock and database time never feed these numbers: lease expiry,
 * deferral and freshness are database times, budgets are monotonic.
 */

export const CASH_ORDER_INGESTION_TIMING_V1 = Object.freeze({
    /** The scheduler tick. One run must end well before the next one starts. */
    TICK_INTERVAL_MS: 120_000,
    FIRST_TICK_DELAY_MS: 30_000,
    RUN_DEADLINE_MS: 110_000,
    /** Authority read, credential call and checkpoint read together. */
    SETUP_MS: 20_000,
    CREDENTIAL_RACE_MS: 6_000,
    /** Transaction maxWait 2 s + timeout 2 s + one running statement 1.5 s + margin. */
    SHORT_DB_OP_MS: 6_000,
    /** Transaction maxWait 2 s + timeout 5 s + one running statement 3 s + lock wait 1 s. */
    WRITE_DB_OP_MS: 11_000,
    LEASE_ACQUISITION_MS: 6_000,
    FINISH_RESERVE_MS: 6_000,
    MARGIN_MS: 1_000,
    REQUEST_TIMEOUT_MIN_MS: 5_000,
    HOT_REQUEST_TIMEOUT_MAX_MS: 10_000,
    RECONCILIATION_REQUEST_TIMEOUT_MAX_MS: 15_000,
    /** A request starts only if it, one write, the finish and the margin fit. */
    ADMISSION_FLOOR_MS: 23_000,
    /** A park (or a tenure) starts only if the lease acquisition and one admitted request fit. */
    PARK_START_FLOOR_MS: 29_000,
    HOT_PARK_BUDGET_MAX_MS: 40_000,
    TARGETED_TENURE_MAX_MS: 40_000,
    /** Greater than every park budget and every single operation; never decides run length. */
    LEASE_TTL_SECONDS: 120,
    POLITE_PAGE_DELAY_MS: 400,
    PAGE_LIMIT: 500,
    SLICE_PAGE_CAP: 20,
    MAX_ENABLED_PARKS: 3,
    MAX_DEFERRAL_SECONDS: 3_600,
})

const T = CASH_ORDER_INGESTION_TIMING_V1

// The floors are derived quantities. Fail at import rather than drift apart.
if (T.ADMISSION_FLOOR_MS !== T.WRITE_DB_OP_MS + T.FINISH_RESERVE_MS + T.MARGIN_MS + T.REQUEST_TIMEOUT_MIN_MS
    || T.PARK_START_FLOOR_MS !== T.LEASE_ACQUISITION_MS + T.ADMISSION_FLOOR_MS) {
    throw new Error('cash-order ingestion timing constants are inconsistent')
}

export interface MonotonicClockV1 {
    /** Milliseconds on a clock that never steps backwards. */
    nowMs(): number
}

export class CashOrderBudgetV1 {
    constructor(
        private readonly clock: MonotonicClockV1,
        readonly deadlineMs: number,
    ) {}

    static fromNow(clock: MonotonicClockV1, durationMs: number): CashOrderBudgetV1 {
        return new CashOrderBudgetV1(clock, clock.nowMs() + durationMs)
    }

    remainingMs(): number {
        return this.deadlineMs - this.clock.nowMs()
    }

    /** A narrower budget that can never outlive this one. */
    child(durationMs: number): CashOrderBudgetV1 {
        return new CashOrderBudgetV1(this.clock, Math.min(this.deadlineMs, this.clock.nowMs() + durationMs))
    }

    admitsParkStart(): boolean {
        return this.remainingMs() >= T.PARK_START_FLOOR_MS
    }

    admitsRequest(): boolean {
        return this.remainingMs() >= T.ADMISSION_FLOOR_MS
    }

    admitsSleep(durationMs: number): boolean {
        return this.remainingMs() - durationMs >= T.ADMISSION_FLOOR_MS
    }

    /**
     * The timeout an admitted request may use: its profile maximum, cut so the
     * write, the finish and the margin still fit. Never below the 5 s minimum
     * while the request is admitted.
     */
    requestTimeoutMs(maximumMs: number): number {
        const reserve = T.WRITE_DB_OP_MS + T.FINISH_RESERVE_MS + T.MARGIN_MS
        return Math.max(0, Math.min(maximumMs, this.remainingMs() - reserve))
    }
}

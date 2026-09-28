/**
 * The read-only cash-order preflight.
 *
 * This is the authorization probe in the release sequence
 * off → preflight → write. It answers one question: if the runtime were
 * allowed to write, would it succeed? To answer it honestly the probe has to
 * do the real thing — read the authoritative park metadata, bind a real
 * credential to it, call the provider, page through a real window, and
 * classify every order with the same rules the writer uses — while persisting
 * nothing at all.
 *
 * It is not the retired `dry_run` mode. That mode ran inside the scheduler and
 * still wrote its checkpoint, lease, progress, run status and cron health. This
 * probe holds no write capability: the store it is given refuses every mutating
 * method before reaching a transaction, and it never takes a lease, records
 * progress, finishes a run or passes through the operational job wrapper. What
 * the operator gets instead is the returned report.
 *
 * Because it writes nothing it needs no lease and no mutual exclusion: two
 * probes, or a probe beside anything else, cannot corrupt state. It deliberately
 * refuses to run while the runtime mode is `write`, so an operator cannot use an
 * authorization probe as a live diagnostic against active ingestion.
 */

import {
    CashOrderBudgetV1,
    CASH_ORDER_INGESTION_TIMING_V1 as T,
    type MonotonicClockV1,
} from './cash-order-ingestion-budget'
import type { CashOrderIngestionConfigErrorV1, CashOrderIngestionConfigV1 } from './cash-order-ingestion-config'
import {
    addCashOrderSliceCountersV1,
    emptyCashOrderSliceCountersV1,
    runCashOrderSliceV1,
    type CashOrderSliceCountersV1,
} from './cash-order-ingestion-slice'
import { CASH_ORDER_PROVIDER_V1 } from './cash-order-ingestion-store'
import {
    hotWindowV1,
    nextReconciliationSliceV1,
    planReconciliationV1,
    type BookingWindowV1,
} from './cash-order-ingestion-windows'
import {
    classifyCashOrderParkAuthorityV1,
    crossCheckCashOrderCredentialsV1,
    type CashOrderCredentialIdentityV1,
} from './cash-order-park-authority'
import type { CashOrderRejectionV1 } from './compensation-cash-order-projection'
import {
    readOnlyCashOrderIngestionStoreV1,
    type CashOrderPreflightReaderV1,
} from './read-only-cash-order-ingestion-store'
import {
    emptyCashOrderRequestStatsV1,
    HOT_REQUEST_PROFILE_V1,
    RECONCILIATION_REQUEST_PROFILE_V1,
    sanitizedProviderFailureSummaryV1,
    type CashOrderPageFetcherV1,
    type CashOrderProviderCredentialV1,
} from './yandex-cash-order-source'

export interface CashOrderPreflightCredentialEntryV1
    extends CashOrderCredentialIdentityV1, CashOrderProviderCredentialV1 {}

export interface CashOrderPreflightPortsV1 {
    reader: CashOrderPreflightReaderV1
    loadCredentials: () => Promise<readonly CashOrderPreflightCredentialEntryV1[]>
    fetchPage: CashOrderPageFetcherV1
    clock: MonotonicClockV1
    wallNowMs: () => number
    sleep: (durationMs: number) => Promise<void>
    random: () => number
}

export interface CashOrderPreflightInputV1 {
    /** Subset of the configured parks. Empty or absent means all of them. */
    parks?: readonly string[]
}

/** Why a preflight could not even start. */
export type CashOrderPreflightRefusalV1 =
    | 'ingestion_mode_write'
    | 'no_enabled_parks'
    | 'park_not_enabled'
    | 'authority_read_failed'

export type CashOrderPreflightWindowKindV1 = 'hot' | 'reconciliation'

export interface CashOrderPreflightWindowReportV1 {
    kind: CashOrderPreflightWindowKindV1
    from: string
    to: string
    status: 'complete' | 'failed'
    /** Sanitized failure code plus HTTP status; never a provider body. */
    failure: string | null
    pages: number
}

export interface CashOrderPreflightParkReportV1 {
    externalParkId: string
    authority: 'authoritative' | string
    credential: 'admitted' | string
    windows: CashOrderPreflightWindowReportV1[]
    provider: 'completed' | 'failed' | 'not_attempted'
    pages: number
    ordersObserved: number
    accepted: number
    rejected: number
    rejectedByReason: Partial<Record<CashOrderRejectionV1, number>>
    removed: number
    removedByReason: Record<string, number>
    collapsedDuplicates: number
    http429: number
    retries429: number
    retries5xx: number
    timeouts: number
    truncated: boolean
    sufficient: boolean
    reasons: string[]
}

export interface CashOrderPreflightReportV1 {
    ok: boolean
    mode: string
    configError: CashOrderIngestionConfigErrorV1 | null
    refusal: CashOrderPreflightRefusalV1 | null
    parksAttempted: string[]
    parks: CashOrderPreflightParkReportV1[]
    sufficientToAuthorizeWriteMode: boolean
    reasons: string[]
}

const iso = (value: Date) => value.toISOString()

function refused(
    config: CashOrderIngestionConfigV1,
    refusal: CashOrderPreflightRefusalV1,
    parksAttempted: string[] = [],
): CashOrderPreflightReportV1 {
    return {
        ok: false,
        mode: config.mode,
        configError: config.configError,
        refusal,
        parksAttempted,
        parks: [],
        sufficientToAuthorizeWriteMode: false,
        reasons: [refusal],
    }
}

/**
 * The windows one park is probed over, both derived from the database's own
 * clock by the existing window rules: the hot window the writer refreshes every
 * tick, and the newest reconciliation slice of a fresh dry-run horizon pass.
 * Nothing here is operator-supplied, so two probes minutes apart examine
 * comparable ranges and neither can be narrowed to make a failure disappear.
 */
export function cashOrderPreflightWindowsV1(dbNow: Date): Array<{ kind: CashOrderPreflightWindowKindV1; window: BookingWindowV1 }> {
    const windows: Array<{ kind: CashOrderPreflightWindowKindV1; window: BookingWindowV1 }> = [
        { kind: 'hot', window: hotWindowV1(dbNow) },
    ]
    const plan = planReconciliationV1(
        { passStartedAt: null, floor: null, cursor: null, completedAt: null },
        dbNow,
        { horizon: 'dry_run' },
    )
    if (plan.due) {
        const slice = nextReconciliationSliceV1(plan.pass.cursor, plan.pass.floor)
        if (slice !== null) windows.push({ kind: 'reconciliation', window: slice })
    }
    return windows
}

function ordersObservedV1(counters: CashOrderSliceCountersV1): number {
    const removed = counters.removed.not_completed + counters.removed.not_cash + counters.removed.not_payable
    return counters.accepted + counters.ignored + removed + counters.collapsedDuplicates
}

/**
 * The probe itself.
 *
 * It holds its ports instead of taking them as a call argument, for the same
 * reason its sibling `CashOrderIngestionRuntimeV1` does: the ports are the
 * instance's own collaborators, bound once where the module is composed, and a
 * run then varies only by the park subset the operator asked for. Everything
 * else a run uses — the configured mode and park scope, the canonical windows,
 * the canonical timing budgets — is fixed, so two runs of the same instance are
 * comparable by construction.
 */
export class CashOrderIngestionPreflightV1 {
    constructor(
        private readonly config: CashOrderIngestionConfigV1,
        private readonly ports: CashOrderPreflightPortsV1,
    ) {}

    /** Probes the configured scope, or the named subset of it, and writes nothing. */
    async run(input: CashOrderPreflightInputV1 = {}): Promise<CashOrderPreflightReportV1> {
        // The probe authorizes the move to write mode; running it against live
        // write ingestion would prove nothing about that decision and would add
        // provider load to a park that is already being read.
        if (this.config.mode === 'write') return refused(this.config, 'ingestion_mode_write')
        if (this.config.enabledParks.length === 0) return refused(this.config, 'no_enabled_parks')

        const requested = input.parks === undefined || input.parks.length === 0
            ? [...this.config.enabledParks]
            : [...new Set(input.parks.map((park) => park.trim()).filter((park) => park !== ''))]
        const unknown = requested.filter((park) => !this.config.enabledParks.includes(park))
        if (unknown.length > 0) return refused(this.config, 'park_not_enabled', requested)

        const store = readOnlyCashOrderIngestionStoreV1(this.ports.reader)
        let read: Awaited<ReturnType<CashOrderPreflightReaderV1['readAuthoritySnapshot']>>
        try {
            read = await store.readAuthoritySnapshot()
        } catch {
            return refused(this.config, 'authority_read_failed', requested)
        }
        const dbNow = read.dbNow

        // Same admission order as the writer: authority from metadata first, then
        // one credential read cross-checked against it.
        const authorities = requested.map((park) => classifyCashOrderParkAuthorityV1(park, read.snapshot))
        let entries: readonly CashOrderPreflightCredentialEntryV1[] | 'setup_timeout' | 'credential_read_failed' = []
        if (authorities.some((authority) => authority.status === 'authoritative')) {
            entries = await Promise.race([
                this.ports.loadCredentials().then((value) => value, () => 'credential_read_failed' as const),
                this.ports.sleep(T.CREDENTIAL_RACE_MS).then(() => 'setup_timeout' as const),
            ])
        }

        const run = CashOrderBudgetV1.fromNow(this.ports.clock, T.PREFLIGHT_RUN_DEADLINE_MS)
        const parks: CashOrderPreflightParkReportV1[] = []

        for (const authority of authorities) {
            const report: CashOrderPreflightParkReportV1 = {
                externalParkId: authority.externalParkId,
                authority: authority.status === 'authoritative' ? 'authoritative' : authority.code,
                credential: 'not_attempted',
                windows: [],
                provider: 'not_attempted',
                pages: 0,
                ordersObserved: 0,
                accepted: 0,
                rejected: 0,
                rejectedByReason: {},
                removed: 0,
                removedByReason: {},
                collapsedDuplicates: 0,
                http429: 0,
                retries429: 0,
                retries5xx: 0,
                timeouts: 0,
                truncated: false,
                sufficient: false,
                reasons: [],
            }

            if (authority.status !== 'authoritative') {
                report.reasons.push(`authority_${authority.code}`)
                parks.push(report)
                continue
            }
            if (typeof entries === 'string') {
                report.credential = entries
                report.reasons.push(entries)
                parks.push(report)
                continue
            }
            const bound = crossCheckCashOrderCredentialsV1(authority, entries)
            if (!bound.ok) {
                report.credential = bound.code
                report.reasons.push(bound.code)
                parks.push(report)
                continue
            }
            report.credential = 'admitted'

            const counters = emptyCashOrderSliceCountersV1()
            const stats = emptyCashOrderRequestStatsV1()
            let allWindowsComplete = true
            report.provider = 'completed'

            for (const { kind, window } of cashOrderPreflightWindowsV1(dbNow)) {
                const budget = run.child(T.PREFLIGHT_WINDOW_BUDGET_MS)
                const slice = await runCashOrderSliceV1({
                    store,
                    fetchPage: this.ports.fetchPage,
                    provider: CASH_ORDER_PROVIDER_V1,
                    externalParkId: authority.externalParkId,
                    connectionId: authority.connectionId,
                    credential: bound.entry,
                    // Never used: the slice reads these only to write a page, and
                    // this store refuses to write. They are deliberately values no
                    // lease could match, so a regression cannot silently persist.
                    checkpointId: '',
                    leaseToken: '',
                    window,
                    budget,
                    profile: kind === 'hot' ? HOT_REQUEST_PROFILE_V1 : RECONCILIATION_REQUEST_PROFILE_V1,
                    mode: 'dry_run',
                    finalProgress: null,
                    stats,
                    sleep: this.ports.sleep,
                    random: this.ports.random,
                    wallNowMs: this.ports.wallNowMs,
                })
                addCashOrderSliceCountersV1(counters, slice.counters)
                const failure = slice.status === 'failed'
                    ? sanitizedProviderFailureSummaryV1(slice.code, slice.httpStatus)
                    : null
                report.windows.push({
                    kind,
                    from: iso(window.from),
                    to: iso(window.to),
                    status: slice.status === 'complete' ? 'complete' : 'failed',
                    failure,
                    pages: slice.counters.pages,
                })
                if (slice.status === 'failed') {
                    allWindowsComplete = false
                    report.provider = 'failed'
                    report.reasons.push(`window_${kind}_${slice.code}`)
                    if (slice.code === 'slice_truncated' || slice.code === 'park_time_budget_exhausted') {
                        report.truncated = true
                    }
                    // One failed window is already disqualifying; the remaining one
                    // would only add provider load to a park we will not authorize.
                    break
                }
            }

            report.pages = counters.pages
            report.accepted = counters.accepted
            report.rejected = counters.ignored
            report.rejectedByReason = { ...counters.ignoredByReason }
            report.removed = counters.removed.not_completed + counters.removed.not_cash + counters.removed.not_payable
            report.removedByReason = { ...counters.removed }
            report.collapsedDuplicates = counters.collapsedDuplicates
            report.ordersObserved = ordersObservedV1(counters)
            report.http429 = stats.http429
            report.retries429 = stats.retries429
            report.retries5xx = stats.retries5xx
            report.timeouts = stats.timeouts

            // Deliberately strict: an authorization probe that had to be retried
            // through throttling has not shown that write mode would keep up, and a
            // timeout leaves the window unproven even when a retry succeeded.
            if (report.http429 > 0) report.reasons.push('provider_throttled')
            if (report.timeouts > 0) report.reasons.push('provider_timeout')
            if (report.truncated) report.reasons.push('window_truncated')

            report.sufficient = allWindowsComplete
                && report.windows.length > 0
                && report.windows.every((window) => window.status === 'complete')
                && !report.truncated
                && report.http429 === 0
                && report.timeouts === 0
            if (report.sufficient) report.reasons.push('ok')
            parks.push(report)
        }

        const reasons: string[] = []
        if (this.config.configError !== null) reasons.push(this.config.configError)
        for (const park of parks) {
            if (!park.sufficient) reasons.push(`${park.externalParkId}:${park.reasons[0] ?? 'insufficient'}`)
        }
        const sufficient = this.config.configError === null
            && parks.length > 0
            && parks.every((park) => park.sufficient)

        return {
            ok: true,
            mode: this.config.mode,
            configError: this.config.configError,
            refusal: null,
            parksAttempted: requested,
            parks,
            sufficientToAuthorizeWriteMode: sufficient,
            reasons: sufficient ? ['ok'] : reasons,
        }
    }
}

/**
 * Cash-order ingestion runtime: one pipeline for every trigger.
 *
 * The background tick, a targeted hot refresh and a targeted day confirmation
 * all run the same setup (park authority, then the credential cross-check),
 * the same lease, the same source adapter, projection and classifier, and the
 * same canonical page writer. They differ only in the booked_at windows they
 * ask for and in which progress their final pages may move:
 *
 *   hot pass        [S − 3 h, S + 10 min]; writes lastHotSuccessAt = S, and
 *                   restarts reconciliation when there was a 30 min gap
 *   reconciliation  6 h slices newest first down to the claim floor; moves the
 *                   pass cursor, and stamps completion at the floor
 *   day target      a narrow window around each stored booking time first,
 *                   then the business day with its 24 h margin; moves no
 *                   progress at all
 *
 * Mode `off` does nothing from any trigger. `dry_run` fetches and classifies
 * on the background tick only, keeps its own reconciliation progress under
 * lastRunSummary.dryRun and writes no order and no freshness. Targeted work
 * runs only in `write`.
 *
 * Day-confirmation records, the page allowance and the tenure queue live in
 * process memory and are lost on restart without harm: nothing a partial run
 * did can make a day covered or an order not confirmed.
 */

import { CashOrderBudgetV1, CASH_ORDER_INGESTION_TIMING_V1 as T, type MonotonicClockV1 } from './cash-order-ingestion-budget'
import type { CashOrderIngestionConfigV1, CashOrderIngestionModeV1 } from './cash-order-ingestion-config'
import {
    addCashOrderSliceCountersV1,
    emptyCashOrderSliceCountersV1,
    runCashOrderSliceV1,
    type CashOrderSliceCountersV1,
} from './cash-order-ingestion-slice'
import {
    CASH_ORDER_PROVIDER_V1,
    type CashOrderCheckpointV1,
    type CashOrderIngestionProgressV1,
    type CashOrderIngestionStoreV1,
    type CashOrderLeaseAcquisitionV1,
} from './cash-order-ingestion-store'
import {
    gapRestartPassV1,
    gapRestartRequiredV1,
    hotAgeExceededV1,
    hotWindowV1,
    mergeBookingWindowsV1,
    narrowBookingWindowV1,
    nextReconciliationSliceV1,
    nextUncoveredSliceV1,
    passAfterSliceV1,
    planReconciliationV1,
    reconciliationAlarmsV1,
    reconciliationPassOfV1,
    reconciliationPassStateV1,
    targetedDayWindowV1,
    targetedDayWithinHorizonV1,
    withReconciliationPassV1,
    type BookingWindowV1,
    type ReconciliationPassV1,
} from './cash-order-ingestion-windows'
import {
    classifyCashOrderParkAuthorityV1,
    crossCheckCashOrderCredentialsV1,
    type CashOrderCredentialIdentityV1,
} from './cash-order-park-authority'
import { CashOrderParkTenureQueueV1 } from './cash-order-park-tenure-queue'
import { parseCompensationBusinessDayKeyV1 } from './compensation-calendar'
import {
    emptyCashOrderRequestStatsV1,
    HOT_REQUEST_PROFILE_V1,
    RECONCILIATION_REQUEST_PROFILE_V1,
    sanitizedProviderFailureSummaryV1,
    type CashOrderPageFetcherV1,
    type CashOrderProviderCredentialV1,
    type CashOrderRequestStatsV1,
} from './yandex-cash-order-source'

const SECOND = 1_000
const MINUTE = 60 * SECOND

export const CASH_ORDER_TARGETED_LIMITS_V1 = Object.freeze({
    /** No hot pass, background or targeted, may start within this of the last one. */
    HOT_REFRESH_DEBOUNCE_MS: 60 * SECOND,
    /** A queued targeted slice that has no lease by then gives up. */
    LEASE_BUSY_MS: 180 * SECOND,
    LEASE_RETRY_MS: 2 * SECOND,
    DAY_DEADLINE_MS: 5 * MINUTE,
    /** A record still running this long after registration was lost. */
    DAY_LOST_MS: 6 * MINUTE,
    PAGE_ALLOWANCE: 30,
    PAGE_ALLOWANCE_WINDOW_MS: 10 * MINUTE,
    /** Authority and credentials are re-proved when the last setup is older. */
    SETUP_REUSE_MS: 110 * SECOND,
    /** Targeted tenures end this long before the park's next tick starts. */
    TICK_CLEARANCE_MS: 6 * SECOND,
})

const L = CASH_ORDER_TARGETED_LIMITS_V1

export interface CashOrderCredentialEntryV1 extends CashOrderCredentialIdentityV1, CashOrderProviderCredentialV1 {}

export interface CashOrderIngestionPortsV1 {
    store: CashOrderIngestionStoreV1
    loadCredentials: () => Promise<readonly CashOrderCredentialEntryV1[]>
    fetchPage: CashOrderPageFetcherV1
    clock: MonotonicClockV1
    wallNowMs: () => number
    sleep: (durationMs: number) => Promise<void>
    random: () => number
    newToken: () => string
    log: (level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>) => void
}

interface AuthorizedParkV1 {
    externalParkId: string
    connectionId: string
    credential: CashOrderCredentialEntryV1
}

type ParkSetupV1 = { ok: true; park: AuthorizedParkV1 } | { ok: false; code: string }

export interface CashOrderPassReportV1 {
    status: 'succeeded' | 'failed' | 'deferred' | 'lease_held'
    code: string | null
    httpStatus: number | null
    startedAt: Date | null
    gapRestart: boolean
    deferredUntil: Date | null
    counters: CashOrderSliceCountersV1
    stats: CashOrderRequestStatsV1
}

export interface CashOrderReconciliationReportV1 {
    status: 'complete' | 'continuation' | 'not_due' | 'failed' | 'deferred' | 'lease_held'
    code: string | null
    slices: number
    pass: ReconciliationPassV1 | null
    counters: CashOrderSliceCountersV1
    stats: CashOrderRequestStatsV1
}

export interface CashOrderParkTickReportV1 {
    externalParkId: string
    hot: CashOrderPassReportV1
    reconciliation: CashOrderReconciliationReportV1 | null
    alarms: string[]
}

export interface CashOrderTickResultV1 {
    mode: CashOrderIngestionModeV1
    parks: CashOrderParkTickReportV1[]
    /** Job errors. A non-empty list means the tick failed. */
    errors: string[]
}

export type CashOrderTargetedOutcomeV1 = 'running' | 'succeeded' | 'decided' | 'complete' | 'incomplete' | `failed:${string}`

export type CashOrderScheduleOutcomeV1 =
    | { status: 'scheduled' | 'joined' }
    | {
        status: 'not_scheduled'
        reason: 'mode_not_write' | 'park_not_enabled' | 'refresh_in_flight' | 'hot_pass_recent'
            | 'provider_deferred' | 'state_read_failed' | 'invalid_day'
    }

interface DayOrderStateV1 {
    externalOrderId: string
    providerBookedAt: Date | null
    narrow: 'pending' | 'not_applicable' | 'ran'
}

interface DayRecordV1 {
    externalParkId: string
    dayKey: string
    registeredAtMs: number
    startDb: Date | null
    endedDb: Date | null
    connectionId: string | null
    fallbackWindow: BookingWindowV1 | null
    coveredRanges: BookingWindowV1[]
    orders: Map<string, DayOrderStateV1>
    /** The latest decisive observation of every order any slice of this record saw. */
    decisions: Map<string, { decision: 'accepted' | 'removed'; via: 'narrow' | 'fallback' }>
    outcome: CashOrderTargetedOutcomeV1
    pages: number
    completion: Promise<void> | null
}

export interface CashOrderDayConfirmationSnapshotV1 {
    externalParkId: string
    dayKey: string
    outcome: CashOrderTargetedOutcomeV1
    startDb: Date | null
    endedDb: Date | null
    connectionId: string | null
    fallbackWindow: BookingWindowV1 | null
    fallbackComplete: boolean
    coveredRanges: BookingWindowV1[]
    pages: number
    orders: Array<{ externalOrderId: string; providerBookedAt: Date | null; narrowTried: boolean }>
    decisions: Array<{ externalOrderId: string; decision: 'accepted' | 'removed'; via: 'narrow' | 'fallback' }>
}

export type CashOrderOrderConfirmationV1 =
    | { state: 'running' }
    | { state: 'confirmed' | 'removed'; via: 'narrow' | 'fallback'; connectionId: string | null }
    /** The whole fallback window was read through this connection and the order was not accepted. */
    | { state: 'not_returned'; connectionId: string; startDb: Date; endedDb: Date | null }
    | { state: 'incomplete'; endedDb: Date | null }
    | { state: 'failed'; code: string; endedDb: Date | null }
    | { state: 'undetermined' }

/**
 * What a day confirmation established about one order. Only a complete
 * fallback that did not accept the order yields `not_returned`; an incomplete
 * or failed record never does, whatever it happened to cover.
 */
export function cashOrderConfirmationForOrderV1(
    snapshot: CashOrderDayConfirmationSnapshotV1 | null,
    externalOrderId: string,
): CashOrderOrderConfirmationV1 {
    if (snapshot === null) return { state: 'undetermined' }
    if (snapshot.outcome === 'running') return { state: 'running' }
    const decided = snapshot.decisions.find((entry) => entry.externalOrderId === externalOrderId)
    if (decided) return { state: decided.decision === 'accepted' ? 'confirmed' : 'removed', via: decided.via, connectionId: snapshot.connectionId }
    if (snapshot.outcome === 'complete' && snapshot.fallbackComplete && snapshot.connectionId !== null && snapshot.startDb !== null) {
        return { state: 'not_returned', connectionId: snapshot.connectionId, startDb: snapshot.startDb, endedDb: snapshot.endedDb }
    }
    if (snapshot.outcome === 'incomplete') return { state: 'incomplete', endedDb: snapshot.endedDb }
    if (snapshot.outcome.startsWith('failed:')) {
        return { state: 'failed', code: snapshot.outcome.slice('failed:'.length), endedDb: snapshot.endedDb }
    }
    return { state: 'undetermined' }
}

function progressOf(checkpoint: CashOrderCheckpointV1): CashOrderIngestionProgressV1 {
    return {
        lastHotSuccessAt: checkpoint.lastHotSuccessAt,
        reconciliationPassStartedAt: checkpoint.reconciliationPassStartedAt,
        reconciliationFloorBookedAt: checkpoint.reconciliationFloorBookedAt,
        reconciliationCursorBookedAt: checkpoint.reconciliationCursorBookedAt,
        lastReconciliationCompletedAt: checkpoint.lastReconciliationCompletedAt,
    }
}

const isoOrNull = (value: Date | null) => (value === null ? null : value.toISOString())

function dateOrNull(value: unknown): Date | null {
    if (typeof value !== 'string') return null
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Dry-run reconciliation progress, kept under lastRunSummary.dryRun. */
interface DryRunProgressV1 {
    pass: ReconciliationPassV1
    passPages: number
    passHttp429: number
}

function dryRunProgressOf(checkpoint: CashOrderCheckpointV1): DryRunProgressV1 {
    const stored = checkpoint.lastRunSummary?.dryRun
    const record = stored !== null && typeof stored === 'object' ? stored as Record<string, unknown> : {}
    return {
        pass: {
            passStartedAt: dateOrNull(record.passStartedAt),
            floor: dateOrNull(record.floor),
            cursor: dateOrNull(record.cursor),
            completedAt: dateOrNull(record.completedAt),
        },
        passPages: typeof record.passPages === 'number' ? record.passPages : 0,
        passHttp429: typeof record.passHttp429 === 'number' ? record.passHttp429 : 0,
    }
}

function emptyPassReport(status: CashOrderPassReportV1['status'], code: string | null = null): CashOrderPassReportV1 {
    return {
        status,
        code,
        httpStatus: null,
        startedAt: null,
        gapRestart: false,
        deferredUntil: null,
        counters: emptyCashOrderSliceCountersV1(),
        stats: emptyCashOrderRequestStatsV1(),
    }
}

function passSummary(report: CashOrderPassReportV1): Record<string, unknown> {
    return {
        status: report.status,
        code: report.code,
        httpStatus: report.httpStatus,
        startedAt: isoOrNull(report.startedAt),
        gapRestart: report.gapRestart,
        deferredUntil: isoOrNull(report.deferredUntil),
        counters: report.counters,
        stats: report.stats,
    }
}

function reconciliationSummary(report: CashOrderReconciliationReportV1): Record<string, unknown> {
    return {
        status: report.status,
        code: report.code,
        slices: report.slices,
        pass: report.pass === null ? null : {
            passStartedAt: isoOrNull(report.pass.passStartedAt),
            floor: isoOrNull(report.pass.floor),
            cursor: isoOrNull(report.pass.cursor),
            completedAt: isoOrNull(report.pass.completedAt),
        },
        counters: report.counters,
        stats: report.stats,
    }
}

export class CashOrderIngestionRuntimeV1 {
    private readonly queues = new Map<string, CashOrderParkTenureQueueV1>()
    private readonly lastHotStartMs = new Map<string, number>()
    private readonly hotRefreshInFlight = new Set<string>()
    private readonly targetedPageTimes = new Map<string, number[]>()
    private readonly dayRecords = new Map<string, DayRecordV1>()
    private lastTickStartMs: number | null = null

    constructor(
        private readonly config: CashOrderIngestionConfigV1,
        private readonly ports: CashOrderIngestionPortsV1,
    ) {}

    get mode(): CashOrderIngestionModeV1 {
        return this.config.mode
    }

    private queue(externalParkId: string): CashOrderParkTenureQueueV1 {
        let queue = this.queues.get(externalParkId)
        if (!queue) {
            queue = new CashOrderParkTenureQueueV1()
            this.queues.set(externalParkId, queue)
        }
        return queue
    }

    private enabled(externalParkId: string): boolean {
        return this.config.configError === null && this.config.enabledParks.includes(externalParkId)
    }

    // ── Setup ──────────────────────────────────────────────────────────────

    /**
     * Authority from metadata, then one credential read cross-checked against
     * it. A park that fails here gets no provider request.
     */
    private async setup(parks: readonly string[]): Promise<{ dbNow: Date | null; results: Map<string, ParkSetupV1> }> {
        const results = new Map<string, ParkSetupV1>()
        let read: Awaited<ReturnType<CashOrderIngestionStoreV1['readAuthoritySnapshot']>>
        try {
            read = await this.ports.store.readAuthoritySnapshot()
        } catch {
            for (const park of parks) results.set(park, { ok: false, code: 'authority_read_failed' })
            return { dbNow: null, results }
        }
        const authorities = parks.map((park) => classifyCashOrderParkAuthorityV1(park, read.snapshot))
        let entries: readonly CashOrderCredentialEntryV1[] | 'setup_timeout' | 'credential_read_failed' = []
        if (authorities.some((authority) => authority.status === 'authoritative')) {
            entries = await Promise.race([
                this.ports.loadCredentials().then((value) => value, () => 'credential_read_failed' as const),
                this.ports.sleep(T.CREDENTIAL_RACE_MS).then(() => 'setup_timeout' as const),
            ])
        }
        for (const authority of authorities) {
            if (authority.status === 'failed') {
                results.set(authority.externalParkId, { ok: false, code: authority.code })
            } else if (typeof entries === 'string') {
                results.set(authority.externalParkId, { ok: false, code: entries })
            } else {
                const bound = crossCheckCashOrderCredentialsV1(authority, entries)
                results.set(authority.externalParkId, bound.ok
                    ? { ok: true, park: { externalParkId: authority.externalParkId, connectionId: authority.connectionId, credential: bound.entry } }
                    : { ok: false, code: bound.code })
            }
        }
        return { dbNow: read.dbNow, results }
    }

    private deferred(checkpoint: CashOrderCheckpointV1 | undefined, connectionId: string, dbNow: Date): boolean {
        return checkpoint !== undefined
            && checkpoint.providerRetryNotBefore !== null
            && checkpoint.providerRetryNotBefore.getTime() > dbNow.getTime()
            && checkpoint.providerRetryConnectionId === connectionId
    }

    /** Whether a provider deferral applies to the park's current connection. No credential read. */
    private async deferralActive(externalParkId: string): Promise<boolean> {
        const read = await this.ports.store.readCheckpoints(CASH_ORDER_PROVIDER_V1, [externalParkId])
        const checkpoint = read.checkpoints[0]
        if (!checkpoint || checkpoint.providerRetryNotBefore === null
            || checkpoint.providerRetryNotBefore.getTime() <= read.dbNow.getTime()) return false
        const authority = classifyCashOrderParkAuthorityV1(externalParkId, (await this.ports.store.readAuthoritySnapshot()).snapshot)
        return authority.status === 'authoritative' && authority.connectionId === checkpoint.providerRetryConnectionId
    }

    // ── Lease and slices ───────────────────────────────────────────────────

    private async acquireParkLease(
        park: AuthorizedParkV1,
        token: string,
        budget: CashOrderBudgetV1,
        retryUntilMs: number | null,
    ): Promise<CashOrderLeaseAcquisitionV1 | null> {
        for (;;) {
            let acquisition: CashOrderLeaseAcquisitionV1
            try {
                acquisition = await this.ports.store.acquireLease({ provider: CASH_ORDER_PROVIDER_V1, externalParkId: park.externalParkId, token })
            } catch {
                return null
            }
            if (acquisition.acquired || retryUntilMs === null) return acquisition
            const now = this.ports.clock.nowMs()
            if (now + L.LEASE_RETRY_MS >= retryUntilMs || budget.remainingMs() - L.LEASE_RETRY_MS < T.PARK_START_FLOOR_MS) {
                return acquisition
            }
            await this.ports.sleep(L.LEASE_RETRY_MS)
        }
    }

    private async releaseParkLease(checkpointId: string, token: string): Promise<void> {
        try {
            await this.ports.store.releaseLease({ checkpointId, token })
        } catch {
            // The lease expires on its own; a failed release only delays the next holder.
            this.ports.log('warn', 'cash_order_ingestion_lease_release_failed', { operation: 'compensation_cash_order_ingestion' })
        }
    }

    private admitTargetedPage(externalParkId: string): boolean {
        const now = this.ports.clock.nowMs()
        const recent = (this.targetedPageTimes.get(externalParkId) ?? []).filter((at) => now - at < L.PAGE_ALLOWANCE_WINDOW_MS)
        if (recent.length >= L.PAGE_ALLOWANCE) {
            this.targetedPageTimes.set(externalParkId, recent)
            return false
        }
        recent.push(now)
        this.targetedPageTimes.set(externalParkId, recent)
        return true
    }

    /**
     * One hot pass under one lease. S is the database time of the lease
     * acquisition, read immediately before the first request.
     */
    private async hotPass(
        park: AuthorizedParkV1,
        budget: CashOrderBudgetV1,
        trigger: 'background' | 'targeted',
        leaseRetryUntilMs: number | null,
    ): Promise<CashOrderPassReportV1> {
        const token = this.ports.newToken()
        const acquisition = await this.acquireParkLease(park, token, budget, leaseRetryUntilMs)
        if (acquisition === null) return emptyPassReport('failed', 'lease_acquisition_failed')
        if (!acquisition.acquired) return emptyPassReport('lease_held')
        const { checkpoint, dbNow: startedAt } = acquisition
        const report = emptyPassReport('failed')
        report.startedAt = startedAt
        let leaseLost = false
        try {
            if (this.deferred(checkpoint, park.connectionId, startedAt)) {
                report.status = 'deferred'
                report.deferredUntil = checkpoint.providerRetryNotBefore
                return report
            }
            this.lastHotStartMs.set(park.externalParkId, this.ports.clock.nowMs())
            let finalProgress: { expected: CashOrderIngestionProgressV1; next: CashOrderIngestionProgressV1 } | null = null
            if (this.config.mode === 'write') {
                const expected = progressOf(checkpoint)
                const withHot = { ...expected, lastHotSuccessAt: startedAt }
                report.gapRestart = gapRestartRequiredV1(expected.lastHotSuccessAt, startedAt)
                finalProgress = {
                    expected,
                    next: report.gapRestart ? withReconciliationPassV1(withHot, gapRestartPassV1(startedAt)) : withHot,
                }
            }
            const slice = await runCashOrderSliceV1({
                store: this.ports.store,
                fetchPage: this.ports.fetchPage,
                provider: CASH_ORDER_PROVIDER_V1,
                externalParkId: park.externalParkId,
                connectionId: park.connectionId,
                credential: park.credential,
                checkpointId: checkpoint.id,
                leaseToken: token,
                window: hotWindowV1(startedAt),
                budget,
                profile: HOT_REQUEST_PROFILE_V1,
                mode: this.config.mode === 'write' ? 'write' : 'dry_run',
                finalProgress,
                admitPage: trigger === 'targeted' ? () => this.admitTargetedPage(park.externalParkId) : undefined,
                stats: report.stats,
                sleep: this.ports.sleep,
                random: this.ports.random,
                wallNowMs: this.ports.wallNowMs,
            })
            addCashOrderSliceCountersV1(report.counters, slice.counters)
            if (slice.status === 'complete') {
                report.status = 'succeeded'
                return report
            }
            report.code = slice.code
            report.httpStatus = slice.httpStatus
            leaseLost = slice.code === 'lease_lost'
            if (slice.deferSeconds !== null && !leaseLost) {
                report.deferredUntil = await this.recordDeferral(checkpoint.id, token, slice.deferSeconds, park.connectionId)
            }
            return report
        } finally {
            if (!leaseLost) await this.releaseParkLease(checkpoint.id, token)
        }
    }

    private async recordDeferral(checkpointId: string, token: string, seconds: number, connectionId: string): Promise<Date | null> {
        try {
            return await this.ports.store.recordDeferral({ checkpointId, token, seconds, connectionId })
        } catch {
            return null
        }
    }

    // ── Background tick ────────────────────────────────────────────────────

    /** One scheduler tick. Never throws; job errors are returned in `errors`. */
    async runTick(): Promise<CashOrderTickResultV1> {
        const mode = this.config.mode
        if (mode === 'off') return { mode, parks: [], errors: [] }
        this.lastTickStartMs = this.ports.clock.nowMs()
        if (this.config.configError !== null) return { mode, parks: [], errors: [this.config.configError] }

        const run = CashOrderBudgetV1.fromNow(this.ports.clock, T.RUN_DEADLINE_MS)
        const parks = [...this.config.enabledParks]
        const errors: string[] = []
        const reports: CashOrderParkTickReportV1[] = []
        const pendingHot = new Set(parks)
        for (const park of parks) this.queue(park).beginBackgroundHot()
        const endHot = (park: string) => {
            if (pendingHot.delete(park)) this.queue(park).endBackgroundHot()
        }

        try {
            const setup = await this.setup(parks)
            const before = await this.ports.store.readCheckpoints(CASH_ORDER_PROVIDER_V1, parks).catch(() => null)
            const checkpointOf = (park: string) => before?.checkpoints.find((checkpoint) => checkpoint.externalParkId === park)
            const order = (value: Date | null | undefined) => value?.getTime() ?? Number.NEGATIVE_INFINITY
            const ordered = [...parks].sort((left, right) => (
                order(checkpointOf(left)?.lastHotSuccessAt) - order(checkpointOf(right)?.lastHotSuccessAt)
                || order(checkpointOf(left)?.lastRunStartedAt) - order(checkpointOf(right)?.lastRunStartedAt)
            ))
            const tickStartedDb = setup.dbNow ?? before?.dbNow ?? new Date(this.ports.wallNowMs())
            const authorized = new Map<string, AuthorizedParkV1>()

            for (let index = 0; index < ordered.length; index += 1) {
                const externalParkId = ordered[index]
                const parkSetup = setup.results.get(externalParkId) as ParkSetupV1
                let hot: CashOrderPassReportV1
                if (!parkSetup.ok) {
                    hot = emptyPassReport('failed', parkSetup.code)
                } else {
                    authorized.set(externalParkId, parkSetup.park)
                    const share = Math.floor(run.remainingMs() / (ordered.length - index))
                    const budget = run.child(Math.min(T.HOT_PARK_BUDGET_MAX_MS, share))
                    hot = await this.backgroundHotPass(parkSetup.park, budget)
                }
                endHot(externalParkId)
                reports.push({ externalParkId, hot, reconciliation: null, alarms: [] })
                if (hot.status === 'failed') errors.push(`${externalParkId}:${hot.code}`)
                // Status goes only to a real park key, and never over a lease
                // someone else now holds.
                const writable = hot.status === 'succeeded'
                    || (hot.status === 'failed' && hot.code !== 'lease_lost' && hot.code !== 'park_not_active')
                if (writable) {
                    await this.finishPark(externalParkId, {
                        mode,
                        status: hot.status === 'succeeded' ? 'succeeded' : 'failed',
                        code: hot.code,
                        httpStatus: hot.httpStatus,
                        startedAt: hot.startedAt ?? tickStartedDb,
                        connectionId: parkSetup.ok ? parkSetup.park.connectionId : null,
                        summary: { hot: passSummary(hot) },
                    })
                }
            }

            const after = await this.ports.store.readCheckpoints(CASH_ORDER_PROVIDER_V1, parks).catch(() => null)
            if (after === null) {
                errors.push('checkpoint_read_failed')
                return { mode, parks: reports, errors }
            }

            if (mode === 'write') {
                for (const report of reports) {
                    const checkpoint = after.checkpoints.find((row) => row.externalParkId === report.externalParkId)
                    if (hotAgeExceededV1(checkpoint?.lastHotSuccessAt ?? null, after.dbNow)) report.alarms.push('hot_age_exceeded')
                    if (checkpoint) report.alarms.push(...reconciliationAlarmsV1(reconciliationPassOfV1(progressOf(checkpoint)), after.dbNow))
                    for (const alarm of report.alarms) errors.push(`${report.externalParkId}:${alarm}`)
                }
            }

            const candidate = this.reconciliationCandidate(reports, after.checkpoints, after.dbNow)
            if (candidate !== null && run.admitsParkStart()) {
                const park = authorized.get(candidate) as AuthorizedParkV1
                const report = reports.find((entry) => entry.externalParkId === candidate) as CashOrderParkTickReportV1
                const reconciliation = await this.reconcile(park, run)
                report.reconciliation = reconciliation
                const failed = reconciliation.status === 'failed'
                if (failed) errors.push(`${candidate}:${reconciliation.code}`)
                if (reconciliation.slices > 0 || (failed && reconciliation.code !== 'lease_lost')) {
                    await this.finishPark(candidate, {
                        mode,
                        status: failed ? 'failed' : 'succeeded',
                        code: failed ? reconciliation.code : null,
                        httpStatus: null,
                        startedAt: report.hot.startedAt ?? tickStartedDb,
                        connectionId: park.connectionId,
                        summary: { hot: passSummary(report.hot), reconciliation: reconciliationSummary(reconciliation) },
                    })
                }
            }
            return { mode, parks: reports, errors }
        } catch (error) {
            this.ports.log('error', 'cash_order_ingestion_tick_failed', { operation: 'compensation_cash_order_ingestion' })
            errors.push('tick_failed')
            return { mode, parks: reports, errors }
        } finally {
            for (const park of [...pendingHot]) endHot(park)
        }
    }

    private async backgroundHotPass(park: AuthorizedParkV1, budget: CashOrderBudgetV1): Promise<CashOrderPassReportV1> {
        if (!budget.admitsParkStart()) return emptyPassReport('failed', 'park_time_budget_exhausted')
        const release = await this.queue(park.externalParkId).acquire(
            'background_hot',
            this.ports.sleep(Math.max(0, budget.remainingMs() - T.PARK_START_FLOOR_MS)),
        )
        if (release === null) return emptyPassReport('failed', 'park_time_budget_exhausted')
        try {
            if (!budget.admitsParkStart()) return emptyPassReport('failed', 'park_time_budget_exhausted')
            return await this.hotPass(park, budget, 'background', null)
        } finally {
            release()
        }
    }

    private async finishPark(externalParkId: string, input: {
        mode: 'dry_run' | 'write'
        status: 'succeeded' | 'failed'
        code: string | null
        httpStatus: number | null
        startedAt: Date
        connectionId: string | null
        summary: Record<string, unknown>
    }): Promise<void> {
        try {
            await this.ports.store.finishBackgroundRun({
                provider: CASH_ORDER_PROVIDER_V1,
                externalParkId,
                leaseToken: null,
                mode: input.mode,
                status: input.status,
                startedAt: input.startedAt,
                errorCode: input.code,
                errorSummary: input.code === null ? null : sanitizedProviderFailureSummaryV1(input.code, input.httpStatus),
                apiConnectionId: input.connectionId,
                summary: input.summary,
            })
        } catch {
            this.ports.log('error', 'cash_order_ingestion_finish_failed', { operation: 'compensation_cash_order_ingestion', externalParkId })
        }
    }

    /**
     * The one park reconciled this tick: due, with a successful hot pass this
     * tick, and the oldest pass start (or, when no pass is in progress, the
     * oldest completion).
     */
    private reconciliationCandidate(
        reports: readonly CashOrderParkTickReportV1[],
        checkpoints: readonly CashOrderCheckpointV1[],
        dbNow: Date,
    ): string | null {
        const due: Array<{ externalParkId: string; age: number }> = []
        for (const report of reports) {
            if (report.hot.status !== 'succeeded') continue
            const checkpoint = checkpoints.find((row) => row.externalParkId === report.externalParkId)
            if (!checkpoint) continue
            const pass = this.config.mode === 'write' ? reconciliationPassOfV1(progressOf(checkpoint)) : dryRunProgressOf(checkpoint).pass
            const plan = planReconciliationV1(pass, dbNow, { horizon: this.config.mode === 'write' ? 'claim' : 'dry_run' })
            if (!plan.due) continue
            const anchor = reconciliationPassStateV1(pass) === 'in_progress' ? pass.passStartedAt : (pass.completedAt ?? pass.passStartedAt)
            due.push({ externalParkId: report.externalParkId, age: anchor?.getTime() ?? Number.NEGATIVE_INFINITY })
        }
        due.sort((left, right) => left.age - right.age)
        return due[0]?.externalParkId ?? null
    }

    /**
     * Reconciliation slices for one park until the pass completes, nothing is
     * due, or the run budget ends. Each slice holds the lease alone and
     * re-enters the tenure queue first, behind any waiting targeted slice.
     */
    private async reconcile(park: AuthorizedParkV1, run: CashOrderBudgetV1): Promise<CashOrderReconciliationReportV1> {
        const report: CashOrderReconciliationReportV1 = {
            status: 'not_due',
            code: null,
            slices: 0,
            pass: null,
            counters: emptyCashOrderSliceCountersV1(),
            stats: emptyCashOrderRequestStatsV1(),
        }
        const mode = this.config.mode === 'write' ? 'write' : 'dry_run'
        for (;;) {
            if (!run.admitsParkStart()) {
                if (report.slices > 0) report.status = 'continuation'
                return report
            }
            const release = await this.queue(park.externalParkId).acquire(
                'reconciliation',
                this.ports.sleep(Math.max(0, run.remainingMs() - T.PARK_START_FLOOR_MS)),
            )
            if (release === null) {
                if (report.slices > 0) report.status = 'continuation'
                return report
            }
            try {
                if (!run.admitsParkStart()) {
                    if (report.slices > 0) report.status = 'continuation'
                    return report
                }
                const token = this.ports.newToken()
                const acquisition = await this.acquireParkLease(park, token, run, null)
                if (acquisition === null) {
                    report.status = 'failed'
                    report.code = 'lease_acquisition_failed'
                    return report
                }
                if (!acquisition.acquired) {
                    report.status = 'lease_held'
                    return report
                }
                const { checkpoint, dbNow } = acquisition
                let leaseLost = false
                try {
                    if (this.deferred(checkpoint, park.connectionId, dbNow)) {
                        report.status = 'deferred'
                        return report
                    }
                    const dryRun = dryRunProgressOf(checkpoint)
                    const pass = mode === 'write' ? reconciliationPassOfV1(progressOf(checkpoint)) : dryRun.pass
                    const plan = planReconciliationV1(pass, dbNow, { horizon: mode === 'write' ? 'claim' : 'dry_run' })
                    if (!plan.due) {
                        if (report.slices === 0) report.status = 'not_due'
                        return report
                    }
                    const slice = nextReconciliationSliceV1(plan.pass.cursor, plan.pass.floor)
                    const nextPass = slice === null
                        ? { ...plan.pass, completedAt: dbNow }
                        : passAfterSliceV1(plan.pass, slice, dbNow)
                    const expected = progressOf(checkpoint)
                    const stats = emptyCashOrderRequestStatsV1()
                    let pages = 0

                    if (slice !== null) {
                        const result = await runCashOrderSliceV1({
                            store: this.ports.store,
                            fetchPage: this.ports.fetchPage,
                            provider: CASH_ORDER_PROVIDER_V1,
                            externalParkId: park.externalParkId,
                            connectionId: park.connectionId,
                            credential: park.credential,
                            checkpointId: checkpoint.id,
                            leaseToken: token,
                            window: slice,
                            budget: run,
                            profile: RECONCILIATION_REQUEST_PROFILE_V1,
                            mode,
                            finalProgress: mode === 'write' ? { expected, next: withReconciliationPassV1(expected, nextPass) } : null,
                            stats,
                            sleep: this.ports.sleep,
                            random: this.ports.random,
                            wallNowMs: this.ports.wallNowMs,
                        })
                        addCashOrderSliceCountersV1(report.counters, result.counters)
                        this.addStats(report.stats, stats)
                        pages = result.counters.pages
                        if (result.status === 'failed') {
                            leaseLost = result.code === 'lease_lost'
                            if (result.deferSeconds !== null && !leaseLost) {
                                await this.recordDeferral(checkpoint.id, token, result.deferSeconds, park.connectionId)
                            }
                            // Running out of budget inside a slice is a
                            // continuation: the slice replays next tick.
                            if (result.code === 'park_time_budget_exhausted') {
                                report.status = 'continuation'
                            } else {
                                report.status = 'failed'
                                report.code = result.code
                            }
                            return report
                        }
                    } else if (mode === 'write') {
                        // The cursor already reached the floor without a
                        // recorded completion: record it with an empty page.
                        try {
                            await this.ports.store.writePage({
                                checkpointId: checkpoint.id,
                                leaseToken: token,
                                provider: CASH_ORDER_PROVIDER_V1,
                                externalParkId: park.externalParkId,
                                sourceConnectionId: park.connectionId,
                                accepted: [],
                                removedOrderIds: [],
                                progress: { expected, next: withReconciliationPassV1(expected, nextPass) },
                            })
                        } catch {
                            report.status = 'failed'
                            report.code = 'canonical_write_failed'
                            return report
                        }
                    }

                    if (mode === 'dry_run') {
                        const restarted = plan.kind === 'regular_start'
                        const passPages = (restarted ? 0 : dryRun.passPages) + pages
                        const passHttp429 = (restarted ? 0 : dryRun.passHttp429) + stats.http429
                        const complete = reconciliationPassStateV1(nextPass) === 'complete'
                        const previous = checkpoint.lastRunSummary?.dryRun as Record<string, unknown> | undefined
                        const recorded = await this.ports.store.recordDryRunProgress({
                            checkpointId: checkpoint.id,
                            token,
                            dryRun: {
                                passStartedAt: isoOrNull(nextPass.passStartedAt),
                                floor: isoOrNull(nextPass.floor),
                                cursor: isoOrNull(nextPass.cursor),
                                completedAt: isoOrNull(nextPass.completedAt),
                                passPages,
                                passHttp429,
                                lastPass: complete
                                    ? {
                                        passStartedAt: isoOrNull(nextPass.passStartedAt),
                                        completedAt: isoOrNull(nextPass.completedAt),
                                        durationMs: (nextPass.completedAt as Date).getTime() - (nextPass.passStartedAt as Date).getTime(),
                                        pages: passPages,
                                        http429: passHttp429,
                                    }
                                    : previous?.lastPass ?? null,
                            },
                        }).catch(() => false)
                        if (!recorded) {
                            report.status = 'failed'
                            report.code = 'lease_lost'
                            leaseLost = true
                            return report
                        }
                    }

                    report.slices += 1
                    report.pass = nextPass
                    if (reconciliationPassStateV1(nextPass) === 'complete') {
                        report.status = 'complete'
                        return report
                    }
                    report.status = 'continuation'
                } finally {
                    if (!leaseLost) await this.releaseParkLease(checkpoint.id, token)
                }
            } finally {
                release()
            }
        }
    }

    private addStats(total: CashOrderRequestStatsV1, part: CashOrderRequestStatsV1): void {
        total.attempts += part.attempts
        total.http429 += part.http429
        total.retries429 += part.retries429
        total.retries5xx += part.retries5xx
        total.timeouts += part.timeouts
        total.shortenedAborts += part.shortenedAborts
    }

    // ── Targeted work ──────────────────────────────────────────────────────

    /** Budget a targeted tenure could have now: ends clear of the park's next tick. */
    private targetedTenureMs(): number {
        const now = this.ports.clock.nowMs()
        if (this.lastTickStartMs === null) return T.TARGETED_TENURE_MAX_MS
        let nextTick = this.lastTickStartMs + T.TICK_INTERVAL_MS
        while (nextTick <= now) nextTick += T.TICK_INTERVAL_MS
        return Math.min(T.TARGETED_TENURE_MAX_MS, nextTick - now - L.TICK_CLEARANCE_MS)
    }

    private async acquireTargetedTenure(
        externalParkId: string,
        queuedAtMs: number,
        deadlineMs: number,
    ): Promise<{ release: () => void; budget: CashOrderBudgetV1; leaseRetryUntilMs: number } | { failure: 'lease_busy' | 'deadline' }> {
        const leaseBusyAtMs = queuedAtMs + L.LEASE_BUSY_MS
        for (;;) {
            const now = this.ports.clock.nowMs()
            if (deadlineMs - now < T.PARK_START_FLOOR_MS) return { failure: 'deadline' }
            if (now >= leaseBusyAtMs) return { failure: 'lease_busy' }
            const tenureMs = Math.min(this.targetedTenureMs(), deadlineMs - now)
            if (tenureMs < T.PARK_START_FLOOR_MS) {
                // Too close to the next tick: wait until it has started, so its
                // hot pass is queued ahead of this slice.
                const untilTick = this.targetedTenureMs() + L.TICK_CLEARANCE_MS + SECOND
                await this.ports.sleep(Math.max(1, Math.min(untilTick, leaseBusyAtMs - now, deadlineMs - now)))
                continue
            }
            const release = await this.queue(externalParkId).acquire(
                'targeted',
                this.ports.sleep(Math.max(1, Math.min(leaseBusyAtMs, deadlineMs) - now)),
            )
            if (release === null) continue
            const granted = this.ports.clock.nowMs()
            const budgetMs = Math.min(this.targetedTenureMs(), deadlineMs - granted)
            if (budgetMs < T.PARK_START_FLOOR_MS) {
                release()
                continue
            }
            return {
                release,
                budget: CashOrderBudgetV1.fromNow(this.ports.clock, budgetMs),
                leaseRetryUntilMs: Math.min(leaseBusyAtMs, deadlineMs),
            }
        }
    }

    /**
     * Schedules one targeted hot refresh of an enabled park. It never waits
     * for the provider: the returned completion settles when the run ends.
     */
    async requestHotRefresh(externalParkId: string): Promise<CashOrderScheduleOutcomeV1 & { completion?: Promise<CashOrderTargetedOutcomeV1> }> {
        if (this.config.mode !== 'write') return { status: 'not_scheduled', reason: 'mode_not_write' }
        if (!this.enabled(externalParkId)) return { status: 'not_scheduled', reason: 'park_not_enabled' }
        if (this.hotRefreshInFlight.has(externalParkId)) return { status: 'not_scheduled', reason: 'refresh_in_flight' }
        const lastHot = this.lastHotStartMs.get(externalParkId)
        if (lastHot !== undefined && this.ports.clock.nowMs() - lastHot < L.HOT_REFRESH_DEBOUNCE_MS) {
            return { status: 'not_scheduled', reason: 'hot_pass_recent' }
        }
        this.hotRefreshInFlight.add(externalParkId)
        let deferred: boolean
        try {
            deferred = await this.deferralActive(externalParkId)
        } catch {
            this.hotRefreshInFlight.delete(externalParkId)
            return { status: 'not_scheduled', reason: 'state_read_failed' }
        }
        if (deferred) {
            this.hotRefreshInFlight.delete(externalParkId)
            return { status: 'not_scheduled', reason: 'provider_deferred' }
        }
        const completion = this.runTargetedHot(externalParkId).finally(() => {
            this.hotRefreshInFlight.delete(externalParkId)
        })
        return { status: 'scheduled', completion }
    }

    private async runTargetedHot(externalParkId: string): Promise<CashOrderTargetedOutcomeV1> {
        const queuedAtMs = this.ports.clock.nowMs()
        let outcome: CashOrderTargetedOutcomeV1 = 'failed:lost'
        let report: CashOrderPassReportV1 | null = null
        try {
            const setup = (await this.setup([externalParkId])).results.get(externalParkId) as ParkSetupV1
            if (!setup.ok) {
                outcome = `failed:${setup.code}`
                return outcome
            }
            const tenure = await this.acquireTargetedTenure(externalParkId, queuedAtMs, queuedAtMs + L.LEASE_BUSY_MS + T.TARGETED_TENURE_MAX_MS)
            if ('failure' in tenure) {
                outcome = 'failed:lease_busy'
                return outcome
            }
            try {
                report = await this.hotPass(setup.park, tenure.budget, 'targeted', tenure.leaseRetryUntilMs)
            } finally {
                tenure.release()
            }
            outcome = report.status === 'succeeded' ? 'succeeded'
                : report.status === 'deferred' ? 'failed:provider_deferred'
                    : report.status === 'lease_held' ? 'failed:lease_busy'
                        : `failed:${report.code}`
            return outcome
        } catch {
            outcome = 'failed:internal_error'
            return outcome
        } finally {
            await this.recordTargeted(externalParkId, {
                target: 'hot',
                outcome,
                pages: report?.counters.pages ?? 0,
                startedAt: isoOrNull(report?.startedAt ?? null),
            })
        }
    }

    private async recordTargeted(externalParkId: string, summary: Record<string, unknown>): Promise<Date | null> {
        try {
            const endedDb = await this.ports.store.readDatabaseNow()
            await this.ports.store.recordTargetedSummary({
                provider: CASH_ORDER_PROVIDER_V1,
                externalParkId,
                summary: { ...summary, endedAt: endedDb.toISOString() },
            })
            return endedDb
        } catch {
            this.ports.log('warn', 'cash_order_ingestion_targeted_summary_failed', { operation: 'compensation_cash_order_ingestion', externalParkId })
            return null
        }
    }

    /**
     * Schedules, or joins, the confirmation of business day D of a park. An
     * order joining with a stored booking time gets its narrow query ahead of
     * any remaining fallback slice.
     */
    async requestDayConfirmation(input: {
        externalParkId: string
        dayKey: string
        order?: { externalOrderId: string; providerBookedAt: Date | null }
    }): Promise<CashOrderScheduleOutcomeV1> {
        if (this.config.mode !== 'write') return { status: 'not_scheduled', reason: 'mode_not_write' }
        if (!this.enabled(input.externalParkId)) return { status: 'not_scheduled', reason: 'park_not_enabled' }
        try {
            parseCompensationBusinessDayKeyV1(input.dayKey)
        } catch {
            return { status: 'not_scheduled', reason: 'invalid_day' }
        }
        const key = `${input.externalParkId}|${input.dayKey}`
        const existing = this.dayRecords.get(key)
        if (existing && this.effectiveOutcome(existing) === 'running') {
            if (input.order) this.joinOrder(existing, input.order)
            return { status: 'joined' }
        }

        const record: DayRecordV1 = {
            externalParkId: input.externalParkId,
            dayKey: input.dayKey,
            registeredAtMs: this.ports.clock.nowMs(),
            startDb: null,
            endedDb: null,
            connectionId: null,
            fallbackWindow: null,
            coveredRanges: [],
            orders: new Map(),
            decisions: new Map(),
            outcome: 'running',
            pages: 0,
            completion: null,
        }
        if (input.order) this.joinOrder(record, input.order)
        this.dayRecords.set(key, record)

        let deferred: boolean
        try {
            deferred = await this.deferralActive(input.externalParkId)
        } catch {
            record.outcome = 'failed:state_read_failed'
            record.endedDb = null
            return { status: 'not_scheduled', reason: 'state_read_failed' }
        }
        if (deferred) {
            record.outcome = 'failed:provider_deferred'
            record.endedDb = await this.ports.store.readDatabaseNow().catch(() => null)
            return { status: 'not_scheduled', reason: 'provider_deferred' }
        }
        record.completion = this.runDayConfirmation(record)
        return { status: 'scheduled' }
    }

    private joinOrder(record: DayRecordV1, order: { externalOrderId: string; providerBookedAt: Date | null }): void {
        if (record.orders.has(order.externalOrderId)) return
        record.orders.set(order.externalOrderId, {
            externalOrderId: order.externalOrderId,
            providerBookedAt: order.providerBookedAt,
            narrow: order.providerBookedAt === null ? 'not_applicable' : 'pending',
        })
    }

    private effectiveOutcome(record: DayRecordV1): CashOrderTargetedOutcomeV1 {
        if (record.outcome === 'running' && this.ports.clock.nowMs() - record.registeredAtMs >= L.DAY_LOST_MS) return 'failed:lost'
        return record.outcome
    }

    private async runDayConfirmation(record: DayRecordV1): Promise<void> {
        const deadlineMs = record.registeredAtMs + L.DAY_DEADLINE_MS
        let park: AuthorizedParkV1 | null = null
        let setupAtMs = Number.NEGATIVE_INFINITY
        try {
            for (;;) {
                if (this.ports.clock.nowMs() >= deadlineMs) {
                    record.outcome = 'incomplete'
                    return
                }
                if (park === null || this.ports.clock.nowMs() - setupAtMs > L.SETUP_REUSE_MS) {
                    const setup = await this.setup([record.externalParkId])
                    const result = setup.results.get(record.externalParkId) as ParkSetupV1
                    if (!result.ok) {
                        record.outcome = `failed:${result.code}`
                        return
                    }
                    if (record.connectionId !== null && record.connectionId !== result.park.connectionId) {
                        record.outcome = 'failed:authority_connection_changed'
                        return
                    }
                    if (record.startDb === null) {
                        const dbNow = setup.dbNow as Date
                        if (!targetedDayWithinHorizonV1(record.dayKey, dbNow)) {
                            record.outcome = 'failed:day_outside_horizon'
                            return
                        }
                        record.fallbackWindow = targetedDayWindowV1(record.dayKey, dbNow)
                        if (record.fallbackWindow === null) {
                            record.outcome = 'failed:day_not_open'
                            return
                        }
                        record.startDb = dbNow
                        record.connectionId = result.park.connectionId
                    }
                    park = result.park
                    setupAtMs = this.ports.clock.nowMs()
                }

                const work = this.nextDayWork(record)
                if (work.kind === 'done') {
                    record.outcome = work.outcome
                    return
                }

                const queuedAtMs = this.ports.clock.nowMs()
                const tenure = await this.acquireTargetedTenure(record.externalParkId, queuedAtMs, deadlineMs)
                if ('failure' in tenure) {
                    record.outcome = tenure.failure === 'deadline' ? 'incomplete' : 'failed:lease_busy'
                    return
                }
                let step: 'continue' | 'stop'
                try {
                    step = await this.runDayTenure(record, park, work, tenure, deadlineMs)
                } finally {
                    tenure.release()
                }
                if (step === 'stop') return
            }
        } catch {
            record.outcome = 'failed:internal_error'
        } finally {
            if (record.outcome === 'running') record.outcome = 'failed:lost'
            record.endedDb = await this.recordTargeted(record.externalParkId, {
                target: 'day',
                dayKey: record.dayKey,
                outcome: record.outcome,
                pages: record.pages,
                connectionId: record.connectionId,
                startedAt: isoOrNull(record.startDb),
            })
        }
    }

    /** One slice of a day confirmation under one tenure and one lease. */
    private async runDayTenure(
        record: DayRecordV1,
        park: AuthorizedParkV1,
        work: { kind: 'narrow'; externalOrderId: string; window: BookingWindowV1 } | { kind: 'fallback'; window: BookingWindowV1 },
        tenure: { budget: CashOrderBudgetV1; leaseRetryUntilMs: number },
        deadlineMs: number,
    ): Promise<'continue' | 'stop'> {
        const token = this.ports.newToken()
        const acquisition = await this.acquireParkLease(park, token, tenure.budget, tenure.leaseRetryUntilMs)
        if (acquisition === null || !acquisition.acquired) {
            const now = this.ports.clock.nowMs()
            if (now < tenure.leaseRetryUntilMs) return 'continue'
            record.outcome = now >= deadlineMs ? 'incomplete' : 'failed:lease_busy'
            return 'stop'
        }
        const { checkpoint, dbNow } = acquisition
        let leaseLost = false
        try {
            if (this.deferred(checkpoint, park.connectionId, dbNow)) {
                record.outcome = 'failed:provider_deferred'
                return 'stop'
            }
            const slice = await runCashOrderSliceV1({
                store: this.ports.store,
                fetchPage: this.ports.fetchPage,
                provider: CASH_ORDER_PROVIDER_V1,
                externalParkId: park.externalParkId,
                connectionId: park.connectionId,
                credential: park.credential,
                checkpointId: checkpoint.id,
                leaseToken: token,
                window: work.window,
                budget: tenure.budget,
                profile: HOT_REQUEST_PROFILE_V1,
                mode: 'write',
                finalProgress: null,
                admitPage: () => this.admitTargetedPage(park.externalParkId),
                stats: emptyCashOrderRequestStatsV1(),
                sleep: this.ports.sleep,
                random: this.ports.random,
                wallNowMs: this.ports.wallNowMs,
            })
            record.pages += slice.counters.pages
            // Every page that committed is a real observation, whether or not
            // the slice went on to complete.
            const via = work.kind === 'narrow' ? 'narrow' : 'fallback'
            for (const id of slice.acceptedOrderIds) record.decisions.set(id, { decision: 'accepted', via })
            for (const id of slice.removedOrderIds) record.decisions.set(id, { decision: 'removed', via })
            if (slice.status === 'complete') {
                if (work.kind === 'narrow') {
                    const order = record.orders.get(work.externalOrderId)
                    if (order) order.narrow = 'ran'
                } else {
                    record.coveredRanges = mergeBookingWindowsV1([...record.coveredRanges, work.window])
                }
                return 'continue'
            }
            leaseLost = slice.code === 'lease_lost'
            if (slice.deferSeconds !== null && !leaseLost) {
                await this.recordDeferral(checkpoint.id, token, slice.deferSeconds, park.connectionId)
            }
            // Budget ran out inside the slice: it restarts from its upper edge
            // in a later tenure. A narrow miss is not a failure either way.
            if (slice.code === 'park_time_budget_exhausted') return 'continue'
            record.outcome = `failed:${slice.code}`
            return 'stop'
        } finally {
            if (!leaseLost) await this.releaseParkLease(checkpoint.id, token)
        }
    }

    private nextDayWork(record: DayRecordV1):
        | { kind: 'narrow'; externalOrderId: string; window: BookingWindowV1 }
        | { kind: 'fallback'; window: BookingWindowV1 }
        | { kind: 'done'; outcome: 'decided' | 'complete' } {
        for (const order of record.orders.values()) {
            if (order.narrow === 'pending' && order.providerBookedAt !== null && !record.decisions.has(order.externalOrderId)) {
                return { kind: 'narrow', externalOrderId: order.externalOrderId, window: narrowBookingWindowV1(order.providerBookedAt) }
            }
        }
        const undecided = [...record.orders.keys()].filter((id) => !record.decisions.has(id))
        if (record.orders.size > 0 && undecided.length === 0) return { kind: 'done', outcome: 'decided' }
        const slice = nextUncoveredSliceV1(record.fallbackWindow as BookingWindowV1, record.coveredRanges)
        return slice === null ? { kind: 'done', outcome: 'complete' } : { kind: 'fallback', window: slice }
    }

    /** The current record of a day confirmation, with a stale running record reported lost. */
    readDayConfirmation(externalParkId: string, dayKey: string): CashOrderDayConfirmationSnapshotV1 | null {
        const record = this.dayRecords.get(`${externalParkId}|${dayKey}`)
        if (!record) return null
        const outcome = this.effectiveOutcome(record)
        const fallbackComplete = record.fallbackWindow !== null
            && nextUncoveredSliceV1(record.fallbackWindow, record.coveredRanges) === null
        return {
            externalParkId: record.externalParkId,
            dayKey: record.dayKey,
            outcome,
            startDb: record.startDb,
            endedDb: record.endedDb,
            connectionId: record.connectionId,
            fallbackWindow: record.fallbackWindow,
            fallbackComplete,
            coveredRanges: record.coveredRanges.map((range) => ({ from: range.from, to: range.to })),
            pages: record.pages,
            orders: [...record.orders.values()].map((order) => ({
                externalOrderId: order.externalOrderId,
                providerBookedAt: order.providerBookedAt,
                narrowTried: order.narrow === 'ran',
            })),
            decisions: [...record.decisions.entries()].map(([externalOrderId, entry]) => ({
                externalOrderId,
                decision: entry.decision,
                via: entry.via,
            })),
        }
    }

    /** Test and shutdown support: settles when a day confirmation's run ends. */
    dayConfirmationSettled(externalParkId: string, dayKey: string): Promise<void> {
        return this.dayRecords.get(`${externalParkId}|${dayKey}`)?.completion ?? Promise.resolve()
    }
}

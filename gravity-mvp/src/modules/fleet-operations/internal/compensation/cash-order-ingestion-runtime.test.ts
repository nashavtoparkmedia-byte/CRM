/**
 * Runtime contract for cash-order ingestion, driven through fake timers with
 * an in-memory store that keeps the adapter's lease, guard and
 * compare-and-set semantics, and a fake Fleet API that pages by booked_at.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CASH_ORDER_INGESTION_TIMING_V1 as T } from './cash-order-ingestion-budget'
import type { CashOrderIngestionConfigV1 } from './cash-order-ingestion-config'
import {
    cashOrderConfirmationForOrderV1,
    CashOrderIngestionRuntimeV1,
    type CashOrderCredentialEntryV1,
    type CashOrderIngestionPortsV1,
} from './cash-order-ingestion-runtime'
import {
    cashOrderCheckpointIdV1,
    CashOrderLeaseLostError,
    CashOrderProgressConflictError,
    type CashOrderCheckpointV1,
    type CashOrderIngestionProgressV1,
    type CashOrderIngestionStoreV1,
    type CashOrderPageWriteV1,
} from './cash-order-ingestion-store'
import { businessDayStartV1, cashOrderDayCoveredV1 } from './cash-order-ingestion-windows'
import type { CashOrderActiveLinkV1, CashOrderActiveParkV1 } from './cash-order-park-authority'
import type { CashOrderPageRequestV1, CashOrderPageResponseV1 } from './yandex-cash-order-source'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const YOKO = 'ext-yoko'
const OTHER = 'ext-other'
const START = new Date('2026-09-16T09:00:00.000Z') // 14:00 in Yekaterinburg

// ── In-memory store ───────────────────────────────────────────────────────

interface StoredOrder {
    externalParkId: string
    externalOrderId: string
    externalDriverProfileId: string
    rawPrice: string
    amountKopecks: number
    endedAt: Date
    observedAt: Date
    sourceConnectionId: string
    providerBookedAt: Date | null
}

const PROGRESS_KEYS = [
    'lastHotSuccessAt',
    'reconciliationPassStartedAt',
    'reconciliationFloorBookedAt',
    'reconciliationCursorBookedAt',
    'lastReconciliationCompletedAt',
] as const

/** Map lookup without a method call, so the fake never reads like a database driver. */
function entryOf<V>(entries: Map<string, V>, key: string): V | undefined {
    for (const [candidate, value] of entries) if (candidate === key) return value
    return undefined
}

class MemoryStore implements CashOrderIngestionStoreV1 {
    parks: CashOrderActiveParkV1[] = []
    links: CashOrderActiveLinkV1[] = []
    checkpoints = new Map<string, CashOrderCheckpointV1>()
    orders = new Map<string, StoredOrder>()
    writes: CashOrderPageWriteV1[] = []
    failWrite: ((write: CashOrderPageWriteV1) => boolean) | null = null
    hang: Promise<never> | null = null

    private now(): Date {
        return new Date(Date.now())
    }

    private async gate(): Promise<void> {
        if (this.hang) await this.hang
    }

    private checkpoint(externalParkId: string): CashOrderCheckpointV1 {
        let row = entryOf(this.checkpoints, externalParkId)
        if (!row) {
            row = {
                id: cashOrderCheckpointIdV1('yandex_fleet', externalParkId),
                provider: 'yandex_fleet',
                externalParkId,
                leaseToken: null,
                leaseExpiresAt: null,
                lastRunMode: null,
                lastRunStatus: null,
                lastRunStartedAt: null,
                lastRunFinishedAt: null,
                consecutiveFailures: 0,
                lastErrorCode: null,
                lastErrorSummary: null,
                lastApiConnectionId: null,
                lastRunSummary: null,
                lastHotSuccessAt: null,
                reconciliationPassStartedAt: null,
                reconciliationFloorBookedAt: null,
                reconciliationCursorBookedAt: null,
                lastReconciliationCompletedAt: null,
                providerRetryNotBefore: null,
                providerRetryConnectionId: null,
            }
            this.checkpoints.set(externalParkId, row)
        }
        return row
    }

    private byId(checkpointId: string): CashOrderCheckpointV1 | undefined {
        return [...this.checkpoints.values()].find((row) => row.id === checkpointId)
    }

    private holds(row: CashOrderCheckpointV1 | undefined, token: string): row is CashOrderCheckpointV1 {
        return !!row && row.leaseToken === token && !!row.leaseExpiresAt && row.leaseExpiresAt.getTime() > Date.now()
    }

    async readDatabaseNow() {
        await this.gate()
        return this.now()
    }

    async readAuthoritySnapshot() {
        await this.gate()
        return { dbNow: this.now(), snapshot: { parks: [...this.parks], links: [...this.links] } }
    }

    async readCheckpoints(_provider: string, externalParkIds: readonly string[]) {
        await this.gate()
        return {
            dbNow: this.now(),
            checkpoints: externalParkIds.flatMap((park) => {
                const row = entryOf(this.checkpoints, park)
                return row ? [structuredClone(row)] : []
            }),
        }
    }

    async acquireLease({ externalParkId, token }: { provider: string; externalParkId: string; token: string }) {
        await this.gate()
        const row = this.checkpoint(externalParkId)
        const now = this.now()
        if (row.leaseToken !== null && row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() > now.getTime()) {
            return { acquired: false as const, dbNow: now }
        }
        row.leaseToken = token
        row.leaseExpiresAt = new Date(now.getTime() + 120_000)
        return { acquired: true as const, dbNow: now, checkpoint: structuredClone(row) }
    }

    async releaseLease({ checkpointId, token }: { checkpointId: string; token: string }) {
        const row = this.byId(checkpointId)
        if (row && row.leaseToken === token) {
            row.leaseToken = null
            row.leaseExpiresAt = null
        }
    }

    async writePage(write: CashOrderPageWriteV1) {
        const row = this.byId(write.checkpointId)
        if (!this.holds(row, write.leaseToken)) throw new CashOrderLeaseLostError()
        if (this.failWrite?.(write)) throw new Error('simulated database failure')
        if (write.progress) {
            const expected = write.progress.expected
            const same = PROGRESS_KEYS.every((key) => (row[key]?.getTime() ?? null) === (expected[key]?.getTime() ?? null))
            if (!same) throw new CashOrderProgressConflictError()
        }
        const now = this.now()
        row.leaseExpiresAt = new Date(now.getTime() + 120_000)
        let inserted = 0
        let updated = 0
        let guardedNoops = 0
        for (const accepted of write.accepted) {
            const key = `${write.externalParkId}|${accepted.externalOrderId}`
            const stored = entryOf(this.orders, key)
            if (stored && stored.observedAt.getTime() > now.getTime()) {
                guardedNoops += 1
                continue
            }
            if (stored) updated += 1
            else inserted += 1
            this.orders.set(key, {
                externalParkId: write.externalParkId,
                externalOrderId: accepted.externalOrderId,
                externalDriverProfileId: accepted.externalDriverProfileId,
                rawPrice: accepted.rawPrice,
                amountKopecks: accepted.amountKopecks,
                endedAt: accepted.endedAt,
                observedAt: now,
                sourceConnectionId: write.sourceConnectionId,
                providerBookedAt: accepted.providerBookedAt ?? stored?.providerBookedAt ?? null,
            })
        }
        let removed = 0
        for (const orderId of write.removedOrderIds) {
            if (this.orders.delete(`${write.externalParkId}|${orderId}`)) removed += 1
            else guardedNoops += 1
        }
        if (write.progress) Object.assign(row, write.progress.next)
        this.writes.push(write)
        return { inserted, updated, guardedNoops, removed, driverReassigned: 0, amountChanged: 0, endedAtChanged: 0, observedAt: now }
    }

    async recordDeferral({ checkpointId, token, seconds, connectionId }: { checkpointId: string; token: string; seconds: number; connectionId: string }) {
        const row = this.byId(checkpointId)
        if (!this.holds(row, token)) return null
        row.providerRetryNotBefore = new Date(Date.now() + seconds * 1000)
        row.providerRetryConnectionId = connectionId
        return row.providerRetryNotBefore
    }

    async finishBackgroundRun(input: Parameters<CashOrderIngestionStoreV1['finishBackgroundRun']>[0]) {
        const row = this.checkpoint(input.externalParkId)
        const live = row.leaseToken !== null && row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() > Date.now()
        if (live && row.leaseToken !== input.leaseToken) return false
        row.lastRunMode = input.mode
        row.lastRunStatus = input.status
        row.lastRunStartedAt = input.startedAt
        row.lastRunFinishedAt = this.now()
        row.consecutiveFailures = input.status === 'failed' ? row.consecutiveFailures + 1 : 0
        row.lastErrorCode = input.errorCode
        row.lastErrorSummary = input.errorSummary
        row.lastApiConnectionId = input.apiConnectionId ?? row.lastApiConnectionId
        row.lastRunSummary = { ...(row.lastRunSummary ?? {}), background: structuredClone(input.summary) }
        return true
    }

    async recordTargetedSummary({ externalParkId, summary }: { provider: string; externalParkId: string; summary: Record<string, unknown> }) {
        const row = entryOf(this.checkpoints, externalParkId)
        if (row) row.lastRunSummary = { ...(row.lastRunSummary ?? {}), targeted: structuredClone(summary) }
    }

    async recordDryRunProgress({ checkpointId, token, dryRun }: { checkpointId: string; token: string; dryRun: Record<string, unknown> }) {
        const row = this.byId(checkpointId)
        if (!this.holds(row, token)) return false
        row.lastRunSummary = { ...(row.lastRunSummary ?? {}), dryRun: structuredClone(dryRun) }
        return true
    }

    progress(park: string): CashOrderIngestionProgressV1 {
        const row = this.checkpoint(park)
        return Object.fromEntries(PROGRESS_KEYS.map((key) => [key, row[key]])) as unknown as CashOrderIngestionProgressV1
    }

    order(park: string, orderId: string): StoredOrder | undefined {
        return entryOf(this.orders, `${park}|${orderId}`)
    }
}

// ── Fake Fleet API ────────────────────────────────────────────────────────

interface FleetOrder {
    id: string
    booked_at: string | null
    ended_at: string
    status: string | null
    payment_method: string | null
    price: string
    driver_profile: { id: string }
    short_id: number
}

type Intercept = (request: CashOrderPageRequestV1, index: number) =>
    | CashOrderPageResponseV1
    | { latencyMs: number }
    | 'hang'
    | undefined

class FakeFleet {
    orders = new Map<string, FleetOrder[]>()
    pageSize = 500
    latencyMs = 50
    intercept: Intercept | null = null
    requests: CashOrderPageRequestV1[] = []

    add(park: string, order: Partial<FleetOrder> & { id: string; bookedAt: Date }): void {
        const { bookedAt, ...rest } = order
        const list = this.orders.get(park) ?? []
        list.push({
            booked_at: bookedAt.toISOString(),
            ended_at: new Date(bookedAt.getTime() + 20 * MINUTE).toISOString(),
            status: 'complete',
            payment_method: 'cash',
            price: '335.0000',
            driver_profile: { id: 'profile-1' },
            short_id: 1000 + list.length,
            ...rest,
        })
        this.orders.set(park, list)
    }

    update(park: string, id: string, patch: Partial<FleetOrder>): void {
        const order = (this.orders.get(park) ?? []).find((row) => row.id === id)
        if (order) Object.assign(order, patch)
    }

    requestsFor(park: string): CashOrderPageRequestV1[] {
        return this.requests.filter((request) => request.credentials.parkId === park)
    }

    fetchPage = async (request: CashOrderPageRequestV1): Promise<CashOrderPageResponseV1> => {
        const index = this.requests.push(request) - 1
        const intercepted = this.intercept?.(request, index)
        const latency = intercepted && typeof intercepted === 'object' && 'latencyMs' in intercepted ? intercepted.latencyMs : this.latencyMs
        if (intercepted === 'hang' || latency >= request.timeoutMs) {
            await sleep(request.timeoutMs)
            return { ok: false, kind: 'timeout' }
        }
        await sleep(latency)
        if (intercepted && typeof intercepted === 'object' && !('latencyMs' in intercepted)) return intercepted
        const from = request.bookedFrom.getTime()
        const to = request.bookedTo.getTime()
        const matching = (this.orders.get(request.credentials.parkId) ?? [])
            .filter((order) => order.booked_at !== null && Date.parse(order.booked_at) >= from && Date.parse(order.booked_at) <= to)
            .sort((left, right) => Date.parse(right.booked_at as string) - Date.parse(left.booked_at as string))
        const offset = request.cursor === null ? 0 : Number(request.cursor)
        const page = matching.slice(offset, offset + this.pageSize).map((order) => structuredClone(order))
        const next = offset + this.pageSize < matching.length ? String(offset + this.pageSize) : null
        return { ok: true, orders: page, cursor: next }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Harness ───────────────────────────────────────────────────────────────

function link(park: string, overrides: Partial<CashOrderActiveLinkV1> = {}): CashOrderActiveLinkV1 {
    return {
        linkId: `link-${park}`,
        localParkId: `local-${park}`,
        linkExternalParkId: park,
        parkExternalParkId: park,
        apiConnectionId: `conn-${park}`,
        apiConnectionParkId: park,
        ...overrides,
    }
}

function world(mode: CashOrderIngestionConfigV1['mode'], parks: string[] = [YOKO, OTHER]) {
    const store = new MemoryStore()
    store.parks = [{ id: `local-${YOKO}`, externalParkId: YOKO }, { id: `local-${OTHER}`, externalParkId: OTHER }]
    store.links = [link(YOKO), link(OTHER)]
    const fleet = new FakeFleet()
    let tokens = 0
    const credentialLoads = { count: 0 }
    const ports: CashOrderIngestionPortsV1 = {
        store,
        loadCredentials: async () => {
            credentialLoads.count += 1
            return store.links.map((row): CashOrderCredentialEntryV1 => ({
                connectionId: row.apiConnectionId,
                localParkId: row.localParkId,
                parkId: row.linkExternalParkId,
                clid: `clid-${row.apiConnectionId}`,
                apiKey: `key-${row.apiConnectionId}`,
            }))
        },
        fetchPage: fleet.fetchPage,
        clock: { nowMs: () => performance.now() },
        wallNowMs: () => Date.now(),
        sleep,
        random: () => 0,
        newToken: () => `token-${++tokens}`,
        log: () => undefined,
    }
    const config: CashOrderIngestionConfigV1 = { mode, enabledParks: parks, configError: null }
    return { store, fleet, ports, credentialLoads, runtime: new CashOrderIngestionRuntimeV1(config, ports) }
}

/** Advances fake time only as far as the promise needs. */
async function settle<V>(promise: Promise<V>): Promise<V> {
    let done = false
    let value: V | undefined
    let failure: unknown
    promise.then((result) => { done = true; value = result }, (error) => { done = true; failure = error })
    for (let step = 0; step < 100_000 && !done; step += 1) {
        await vi.advanceTimersToNextTimerAsync()
    }
    if (!done) throw new Error('promise did not settle')
    if (failure) throw failure
    return value as V
}

async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms)
}

const ago = (ms: number) => new Date(Date.now() - ms)

beforeEach(() => {
    vi.useFakeTimers({ now: START, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
})

afterEach(() => {
    vi.useRealTimers()
})

// ── Modes ─────────────────────────────────────────────────────────────────

describe('ingestion modes', () => {
    it('does nothing at all in off mode, from any trigger', async () => {
        const { runtime, store, fleet, credentialLoads } = world('off')
        fleet.add(YOKO, { id: 'o1', bookedAt: ago(HOUR) })
        expect(await settle(runtime.runTick())).toEqual({ mode: 'off', parks: [], errors: [] })
        expect(await runtime.requestHotRefresh(YOKO)).toEqual({ status: 'not_scheduled', reason: 'mode_not_write' })
        expect(await runtime.requestDayConfirmation({ externalParkId: YOKO, dayKey: '2026-09-16' }))
            .toEqual({ status: 'not_scheduled', reason: 'mode_not_write' })
        expect(fleet.requests).toEqual([])
        expect(credentialLoads.count).toBe(0)
        expect(store.checkpoints.size).toBe(0)
    })

    it('fetches and classifies in dry_run without writing orders, freshness or reconciliation', async () => {
        const { runtime, store, fleet } = world('dry_run')
        fleet.add(YOKO, { id: 'o1', bookedAt: ago(HOUR) })
        fleet.add(YOKO, { id: 'o2', bookedAt: ago(30 * HOUR) })
        const result = await settle(runtime.runTick())
        expect(result.errors).toEqual([])
        expect(fleet.requestsFor(YOKO).length).toBeGreaterThan(1)
        expect(store.orders.size).toBe(0)
        expect(store.writes).toEqual([])
        expect(store.progress(YOKO)).toEqual({
            lastHotSuccessAt: null,
            reconciliationPassStartedAt: null,
            reconciliationFloorBookedAt: null,
            reconciliationCursorBookedAt: null,
            lastReconciliationCompletedAt: null,
        })
        const checkpoint = store.checkpoints.get(YOKO) ?? store.checkpoints.get(OTHER)
        expect(checkpoint).toBeDefined()
        const reconciled = [...store.checkpoints.values()].find((row) => row.lastRunSummary?.dryRun)
        expect(reconciled?.lastRunSummary?.dryRun).toMatchObject({ passStartedAt: expect.any(String), cursor: expect.any(String) })
        expect(store.checkpoints.get(YOKO)).toMatchObject({ lastRunMode: 'dry_run', lastRunStatus: 'succeeded' })
        expect(await runtime.requestHotRefresh(YOKO)).toEqual({ status: 'not_scheduled', reason: 'mode_not_write' })
    })

    it('writes orders, freshness and the initial backfill in write mode', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        const bookedAt = ago(HOUR)
        fleet.add(YOKO, { id: 'o1', bookedAt })
        fleet.add(YOKO, { id: 'old', bookedAt: ago(20 * HOUR) })
        const result = await settle(runtime.runTick())
        expect(result.errors).toEqual([])
        const S = result.parks[0].hot.startedAt as Date
        expect(store.order(YOKO, 'o1')).toMatchObject({ sourceConnectionId: `conn-${YOKO}`, amountKopecks: 33_500 })
        expect(store.order(YOKO, 'o1')?.providerBookedAt).toEqual(bookedAt)
        expect(store.progress(YOKO).lastHotSuccessAt).toEqual(S)
        expect(result.parks[0].hot.gapRestart).toBe(true)
        expect(store.progress(YOKO).reconciliationPassStartedAt).toEqual(S)
        // Reconciliation started in the same tick and reached the older order.
        expect(store.order(YOKO, 'old')).toBeDefined()
        expect(store.checkpoints.get(YOKO)).toMatchObject({ lastRunMode: 'write', lastRunStatus: 'succeeded', consecutiveFailures: 0, lastApiConnectionId: `conn-${YOKO}` })
    })
})

// ── Authority and configuration ───────────────────────────────────────────

describe('park authority in the pipeline', () => {
    it('fails a park with duplicate active links closed while the other park runs', async () => {
        const { runtime, store, fleet } = world('write')
        store.links.push(link(YOKO, { linkId: 'link-dup', apiConnectionId: 'conn-dup' }))
        fleet.add(YOKO, { id: 'y1', bookedAt: ago(HOUR) })
        fleet.add(OTHER, { id: 'x1', bookedAt: ago(HOUR) })
        const result = await settle(runtime.runTick())
        expect(fleet.requestsFor(YOKO)).toEqual([])
        expect(store.order(OTHER, 'x1')).toBeDefined()
        expect(result.errors).toContain(`${YOKO}:ambiguous_active_connection`)
        expect(store.checkpoints.get(YOKO)).toMatchObject({ lastRunStatus: 'failed', lastErrorCode: 'ambiguous_active_connection', lastHotSuccessAt: null })
    })

    it('fails the credential cross-check when the capability falls back to legacy entries', async () => {
        const { runtime, ports, fleet, store } = world('write', [YOKO])
        ports.loadCredentials = async () => [{ connectionId: `conn-${YOKO}`, localParkId: null, parkId: YOKO, clid: 'c', apiKey: 'k' }]
        fleet.add(YOKO, { id: 'y1', bookedAt: ago(HOUR) })
        const result = await settle(runtime.runTick())
        expect(result.errors).toEqual([`${YOKO}:authority_credential_mismatch`, `${YOKO}:hot_age_exceeded`])
        expect(fleet.requests).toEqual([])
        expect(store.orders.size).toBe(0)
    })

    it('never writes status for an enabled id with no active Park', async () => {
        const { runtime, store, fleet } = world('write', ['ext-gone'])
        const result = await settle(runtime.runTick())
        expect(result.errors).toContain('ext-gone:park_not_active')
        expect(fleet.requests).toEqual([])
        expect(store.checkpoints.has('ext-gone')).toBe(false)
    })

    it('makes no request at all when more than three parks are enabled', async () => {
        const { ports, fleet } = world('write')
        const runtime = new CashOrderIngestionRuntimeV1({ mode: 'write', enabledParks: ['a', 'b', 'c', 'd'], configError: 'enabled_park_limit_exceeded' }, ports)
        expect(await settle(runtime.runTick())).toEqual({ mode: 'write', parks: [], errors: ['enabled_park_limit_exceeded'] })
        expect(fleet.requests).toEqual([])
        expect(await runtime.requestHotRefresh('a')).toEqual({ status: 'not_scheduled', reason: 'park_not_enabled' })
    })

    it('ends a park with lease_held, writing nothing, when another process holds its lease', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        await store.acquireLease({ provider: 'yandex_fleet', externalParkId: YOKO, token: 'other-process' })
        const result = await settle(runtime.runTick())
        expect(result.parks[0].hot.status).toBe('lease_held')
        expect(fleet.requests).toEqual([])
        expect(store.checkpoints.get(YOKO)?.lastRunStatus).toBeNull()
    })
})

// ── Provider failures and budgets ─────────────────────────────────────────

describe('provider failures', () => {
    it('keeps a 5xx on one park from touching the other park or its own freshness', async () => {
        const { runtime, store, fleet } = world('write')
        fleet.add(YOKO, { id: 'y1', bookedAt: ago(HOUR) })
        fleet.add(OTHER, { id: 'x1', bookedAt: ago(HOUR) })
        fleet.intercept = (request) => (request.credentials.parkId === YOKO ? { ok: false, kind: 'http', status: 502, retryAfter: null } : undefined)
        const result = await settle(runtime.runTick())
        const yoko = result.parks.find((park) => park.externalParkId === YOKO)
        expect(yoko?.hot).toMatchObject({ status: 'failed', code: 'provider_server_error', httpStatus: 502 })
        expect(fleet.requestsFor(YOKO)).toHaveLength(3)
        expect(store.progress(YOKO).lastHotSuccessAt).toBeNull()
        expect(store.checkpoints.get(YOKO)).toMatchObject({ lastRunStatus: 'failed', consecutiveFailures: 1, lastErrorSummary: 'provider_server_error (HTTP 502)' })
        expect(store.order(OTHER, 'x1')).toBeDefined()
        expect(store.progress(OTHER).lastHotSuccessAt).not.toBeNull()
    })

    it('defers a park for its throttled connection, and resumes on a rotated connection', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        fleet.intercept = () => ({ ok: false, kind: 'http', status: 429, retryAfter: '600' })
        const first = await settle(runtime.runTick())
        expect(first.parks[0].hot).toMatchObject({ status: 'failed', code: 'provider_rate_limited' })
        expect(store.checkpoints.get(YOKO)).toMatchObject({ providerRetryConnectionId: `conn-${YOKO}` })

        fleet.intercept = null
        fleet.requests = []
        await advance(2 * MINUTE)
        const second = await settle(runtime.runTick())
        expect(second.parks[0].hot.status).toBe('deferred')
        expect(fleet.requests).toEqual([])

        store.links = [link(OTHER), link(YOKO, { linkId: 'link-rotated', apiConnectionId: 'conn-rotated' })]
        await advance(2 * MINUTE)
        const third = await settle(runtime.runTick())
        expect(third.parks[0].hot.status).toBe('succeeded')
        expect(fleet.requestsFor(YOKO).length).toBeGreaterThan(0)
    })

    it('fails on a repeated cursor, a 20-page slice and a malformed body', async () => {
        const repeated = world('write', [YOKO])
        repeated.fleet.add(YOKO, { id: 'y1', bookedAt: ago(HOUR) })
        repeated.fleet.intercept = (request) => (request.cursor === null
            ? { ok: true, orders: [{ id: 'y1' }], cursor: 'same' }
            : { ok: true, orders: [{ id: 'y2' }], cursor: 'same' })
        expect((await settle(repeated.runtime.runTick())).parks[0].hot.code).toBe('provider_pagination_invalid')

        const long = world('write', [YOKO])
        long.fleet.pageSize = 1
        for (let index = 0; index < 21; index += 1) long.fleet.add(YOKO, { id: `y${index}`, bookedAt: ago(HOUR + index * MINUTE) })
        const truncated = await settle(long.runtime.runTick())
        expect(truncated.parks[0].hot.code).toBe('slice_truncated')
        expect(long.fleet.requests).toHaveLength(20)
        expect(long.store.progress(YOKO).lastHotSuccessAt).toBeNull()

        const malformed = world('write', [YOKO])
        malformed.fleet.intercept = () => ({ ok: false, kind: 'malformed' })
        expect((await settle(malformed.runtime.runTick())).parks[0].hot.code).toBe('provider_response_malformed')
        expect(malformed.fleet.requests).toHaveLength(1)
    })

    it('ends a hanging park within its budget while the other parks complete in the same tick', async () => {
        const { runtime, store, fleet } = world('write', [YOKO, OTHER, 'ext-third'])
        store.parks.push({ id: 'local-ext-third', externalParkId: 'ext-third' })
        store.links.push(link('ext-third'))
        fleet.intercept = (request) => (request.credentials.parkId === YOKO ? 'hang' : undefined)
        const started = performance.now()
        const result = await settle(runtime.runTick())
        expect(performance.now() - started).toBeLessThanOrEqual(T.RUN_DEADLINE_MS)
        expect(result.parks.find((park) => park.externalParkId === YOKO)?.hot).toMatchObject({ status: 'failed', code: 'provider_timeout' })
        expect(result.parks.find((park) => park.externalParkId === OTHER)?.hot.status).toBe('succeeded')
        expect(result.parks.find((park) => park.externalParkId === 'ext-third')?.hot.status).toBe('succeeded')
    })

    it('fails the slice on a page write failure, leaves freshness alone, and replays next tick', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        fleet.add(YOKO, { id: 'y1', bookedAt: ago(HOUR) })
        store.failWrite = () => true
        const first = await settle(runtime.runTick())
        expect(first.parks[0].hot).toMatchObject({ status: 'failed', code: 'canonical_write_failed' })
        expect(store.progress(YOKO).lastHotSuccessAt).toBeNull()
        expect(store.orders.size).toBe(0)

        store.failWrite = null
        await advance(2 * MINUTE)
        const second = await settle(runtime.runTick())
        expect(second.parks[0].hot.status).toBe('succeeded')
        expect(store.order(YOKO, 'y1')).toBeDefined()
    })

    it('picks up a late completion on the next hot pass', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        fleet.add(YOKO, { id: 'late', bookedAt: ago(HOUR), status: 'driving', payment_method: null })
        await settle(runtime.runTick())
        expect(store.order(YOKO, 'late')).toBeUndefined()
        fleet.update(YOKO, 'late', { status: 'complete', payment_method: 'cash' })
        await advance(2 * MINUTE)
        await settle(runtime.runTick())
        expect(store.order(YOKO, 'late')).toBeDefined()
    })
})

// ── Reconciliation ────────────────────────────────────────────────────────

describe('reconciliation', () => {
    it('completes the initial backfill newest first and covers every day of the horizon', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        const result = await settle(runtime.runTick())
        expect(result.parks[0].reconciliation?.status).toBe('complete')
        const reconciliationWindows = fleet.requestsFor(YOKO).slice(1)
        const upperEdges = reconciliationWindows.map((request) => request.bookedTo.getTime())
        expect(upperEdges).toEqual([...upperEdges].sort((left, right) => right - left))
        expect(reconciliationWindows.every((request) => request.bookedTo.getTime() - request.bookedFrom.getTime() <= 6 * HOUR)).toBe(true)
        const progress = store.progress(YOKO)
        expect(progress.lastReconciliationCompletedAt).not.toBeNull()
        expect(cashOrderDayCoveredV1(progress, businessDayStartV1('2026-09-01'))).toBe(true)
    })

    it('resumes from its cursor across ticks when the budget runs out, without a status failure', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        fleet.latencyMs = 8_000
        const first = await settle(runtime.runTick())
        expect(first.errors).toEqual([])
        expect(first.parks[0].reconciliation?.status).toBe('continuation')
        const cursor = store.progress(YOKO).reconciliationCursorBookedAt as Date
        expect(store.progress(YOKO).lastReconciliationCompletedAt).toBeNull()

        await advance(2 * MINUTE)
        fleet.requests = []
        await settle(runtime.runTick())
        const resumed = fleet.requestsFor(YOKO).find((request) => request.bookedTo.getTime() === cursor.getTime())
        expect(resumed).toBeDefined()
        expect(store.checkpoints.get(YOKO)?.lastRunStatus).toBe('succeeded')
    })

    it('starts a regular pass 6 h after the previous start and keeps days covered during it', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        await settle(runtime.runTick())
        const firstPass = store.progress(YOKO)
        expect(firstPass.lastReconciliationCompletedAt).not.toBeNull()

        await advance(2 * MINUTE)
        const early = await settle(runtime.runTick())
        expect(early.parks[0].reconciliation).toBeNull()

        const sinceStart = Date.now() - (firstPass.reconciliationPassStartedAt as Date).getTime()
        await advance(6 * HOUR - sinceStart)
        // Hot passes kept succeeding meanwhile, so this is no gap restart.
        ;(store.checkpoints.get(YOKO) as CashOrderCheckpointV1).lastHotSuccessAt = ago(2 * MINUTE)
        fleet.latencyMs = 8_000
        const regular = await settle(runtime.runTick())
        expect(regular.parks[0].reconciliation?.status).toBe('continuation')
        const during = store.progress(YOKO)
        expect(during.reconciliationPassStartedAt?.getTime()).toBeGreaterThan((firstPass.reconciliationPassStartedAt as Date).getTime())
        expect(during.lastReconciliationCompletedAt).toEqual(firstPass.lastReconciliationCompletedAt)
        expect(cashOrderDayCoveredV1(during, businessDayStartV1('2026-09-10'))).toBe(true)
    })

    it('discovers a correction to an older order on the next regular pass and removes it', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        fleet.add(YOKO, { id: 'old', bookedAt: ago(30 * HOUR) })
        await settle(runtime.runTick())
        expect(store.order(YOKO, 'old')).toBeDefined()
        fleet.update(YOKO, 'old', { status: 'cancelled' })
        await advance(6 * HOUR)
        ;(store.checkpoints.get(YOKO) as CashOrderCheckpointV1).lastHotSuccessAt = ago(2 * MINUTE)
        await settle(runtime.runTick())
        expect(store.order(YOKO, 'old')).toBeUndefined()
    })

    it('restarts after a hot-pass gap of more than 30 min and clears coverage until the cursor passes', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        await settle(runtime.runTick())
        expect(store.progress(YOKO).lastReconciliationCompletedAt).not.toBeNull()
        await advance(31 * MINUTE)
        fleet.latencyMs = 8_000
        const result = await settle(runtime.runTick())
        expect(result.parks[0].hot.gapRestart).toBe(true)
        const progress = store.progress(YOKO)
        expect(progress.lastReconciliationCompletedAt).toBeNull()
        expect(cashOrderDayCoveredV1(progress, businessDayStartV1('2026-09-01'))).toBe(false)
    })

    it('raises completeness alarms as job errors without changing any threshold', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        await settle(runtime.runTick())
        const row = store.checkpoints.get(YOKO) as CashOrderCheckpointV1
        row.reconciliationPassStartedAt = ago(3 * HOUR + 1)
        row.lastReconciliationCompletedAt = ago(13 * HOUR)
        row.lastHotSuccessAt = ago(MINUTE)
        fleet.intercept = () => 'hang'
        const result = await settle(runtime.runTick())
        expect(result.errors).toEqual(expect.arrayContaining([
            `${YOKO}:reconciliation_pass_overdue`,
            `${YOKO}:reconciliation_completion_stale`,
        ]))
        expect(T.HOT_PARK_BUDGET_MAX_MS).toBe(40_000)
    })

    it('never raises reconciliation age alarms in dry_run', async () => {
        const { runtime, store } = world('dry_run', [YOKO])
        await settle(runtime.runTick())
        const row = store.checkpoints.get(YOKO) as CashOrderCheckpointV1
        row.reconciliationPassStartedAt = ago(5 * HOUR)
        row.lastReconciliationCompletedAt = ago(20 * HOUR)
        await advance(2 * MINUTE)
        expect((await settle(runtime.runTick())).errors).toEqual([])
    })
})

// ── Targeted hot refresh ──────────────────────────────────────────────────

describe('targeted hot refresh', () => {
    it('runs one hot pass through the same writer and records only the targeted summary', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        fleet.add(YOKO, { id: 'y1', bookedAt: ago(HOUR) })
        const scheduled = await runtime.requestHotRefresh(YOKO)
        expect(scheduled.status).toBe('scheduled')
        expect(await settle(scheduled.completion as Promise<string>)).toBe('succeeded')
        expect(store.order(YOKO, 'y1')).toMatchObject({ sourceConnectionId: `conn-${YOKO}` })
        expect(store.progress(YOKO).lastHotSuccessAt).not.toBeNull()
        expect(store.checkpoints.get(YOKO)).toMatchObject({ lastRunStatus: null, consecutiveFailures: 0 })
        expect(store.checkpoints.get(YOKO)?.lastRunSummary?.targeted).toMatchObject({ target: 'hot', outcome: 'succeeded' })
    })

    it('is single-flight and debounced against any hot pass in the last 60 s', async () => {
        const { runtime } = world('write', [YOKO])
        const first = await runtime.requestHotRefresh(YOKO)
        expect(await runtime.requestHotRefresh(YOKO)).toEqual({ status: 'not_scheduled', reason: 'refresh_in_flight' })
        await settle(first.completion as Promise<string>)
        expect(await runtime.requestHotRefresh(YOKO)).toEqual({ status: 'not_scheduled', reason: 'hot_pass_recent' })
        await advance(61_000)
        expect((await runtime.requestHotRefresh(YOKO)).status).toBe('scheduled')
    })

    it('schedules nothing, and reads no credentials, while the current connection is deferred', async () => {
        const { runtime, store, credentialLoads } = world('write', [YOKO])
        const row = (await store.acquireLease({ provider: 'yandex_fleet', externalParkId: YOKO, token: 't' }) as { checkpoint: CashOrderCheckpointV1 }).checkpoint
        await store.recordDeferral({ checkpointId: row.id, token: 't', seconds: 300, connectionId: `conn-${YOKO}` })
        await store.releaseLease({ checkpointId: row.id, token: 't' })
        expect(await runtime.requestHotRefresh(YOKO)).toEqual({ status: 'not_scheduled', reason: 'provider_deferred' })
        expect(await runtime.requestDayConfirmation({ externalParkId: YOKO, dayKey: '2026-09-16' }))
            .toEqual({ status: 'not_scheduled', reason: 'provider_deferred' })
        expect(credentialLoads.count).toBe(0)
    })

    it('refuses a park that is not enabled', async () => {
        const { runtime } = world('write', [YOKO])
        expect(await runtime.requestHotRefresh(OTHER)).toEqual({ status: 'not_scheduled', reason: 'park_not_enabled' })
    })
})

// ── Targeted day confirmation ─────────────────────────────────────────────

describe('targeted day confirmation', () => {
    const DAY = '2026-09-15'
    const dayStart = businessDayStartV1(DAY) // 14 Sep 19:00 UTC

    async function confirm(runtime: CashOrderIngestionRuntimeV1, order?: { externalOrderId: string; providerBookedAt: Date | null }) {
        const scheduled = await runtime.requestDayConfirmation({ externalParkId: YOKO, dayKey: DAY, order })
        expect(scheduled.status).toBe('scheduled')
        await settle(runtime.dayConfirmationSettled(YOKO, DAY))
        return runtime.readDayConfirmation(YOKO, DAY)
    }

    it('confirms an order with one narrow page and no fallback', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        const bookedAt = new Date(dayStart.getTime() + 5 * HOUR)
        fleet.add(YOKO, { id: 'o1', bookedAt })
        for (let index = 0; index < 5; index += 1) fleet.add(YOKO, { id: `n${index}`, bookedAt: new Date(dayStart.getTime() + index * HOUR) })
        const snapshot = await confirm(runtime, { externalOrderId: 'o1', providerBookedAt: bookedAt })
        expect(snapshot?.outcome).toBe('decided')
        expect(fleet.requests).toHaveLength(1)
        expect(fleet.requests[0].bookedFrom).toEqual(new Date(bookedAt.getTime() - 5 * MINUTE))
        expect(cashOrderConfirmationForOrderV1(snapshot, 'o1')).toEqual({ state: 'confirmed', via: 'narrow', connectionId: `conn-${YOKO}` })
        expect(store.order(YOKO, 'o1')?.sourceConnectionId).toBe(`conn-${YOKO}`)
        expect(store.progress(YOKO).lastHotSuccessAt).toBeNull()
    })

    it('falls back to the business day when booked_at moved, and stores the new booking time', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        const stale = new Date(dayStart.getTime() + 5 * HOUR)
        const actual = new Date(dayStart.getTime() + 9 * HOUR)
        fleet.add(YOKO, { id: 'o1', bookedAt: actual })
        const snapshot = await confirm(runtime, { externalOrderId: 'o1', providerBookedAt: stale })
        expect(cashOrderConfirmationForOrderV1(snapshot, 'o1')).toMatchObject({ state: 'confirmed', via: 'fallback' })
        expect(store.order(YOKO, 'o1')?.providerBookedAt).toEqual(actual)
    })

    it('reports not_returned only after a complete fallback, and deletes nothing on a miss', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        const bookedAt = new Date(dayStart.getTime() + 5 * HOUR)
        store.orders.set(`${YOKO}|gone`, {
            externalParkId: YOKO, externalOrderId: 'gone', externalDriverProfileId: 'profile-1', rawPrice: '335.0000',
            amountKopecks: 33_500, endedAt: bookedAt, observedAt: ago(2 * HOUR), sourceConnectionId: `conn-${YOKO}`, providerBookedAt: bookedAt,
        })
        fleet.add(YOKO, { id: 'unrelated', bookedAt: new Date(dayStart.getTime() + 2 * HOUR) })
        const snapshot = await confirm(runtime, { externalOrderId: 'gone', providerBookedAt: bookedAt })
        expect(snapshot).toMatchObject({ outcome: 'complete', fallbackComplete: true, connectionId: `conn-${YOKO}` })
        expect(cashOrderConfirmationForOrderV1(snapshot, 'gone')).toMatchObject({ state: 'not_returned', connectionId: `conn-${YOKO}` })
        expect(store.order(YOKO, 'gone')).toBeDefined()
        // Another order of the same day read after the same complete fallback.
        expect(cashOrderConfirmationForOrderV1(snapshot, 'never-seen').state).toBe('not_returned')
    })

    it('goes straight to the fallback when no booking time is stored', async () => {
        const { runtime, fleet } = world('write', [YOKO])
        fleet.add(YOKO, { id: 'o1', bookedAt: new Date(dayStart.getTime() + 3 * HOUR) })
        const snapshot = await confirm(runtime, { externalOrderId: 'o1', providerBookedAt: null })
        expect(fleet.requests[0].bookedTo.getTime() - fleet.requests[0].bookedFrom.getTime()).toBe(6 * HOUR)
        expect(cashOrderConfirmationForOrderV1(snapshot, 'o1')).toMatchObject({ state: 'confirmed', via: 'fallback' })
    })

    it('confirms an order booked more than 24 h before the day through its narrow query', async () => {
        const { runtime, fleet } = world('write', [YOKO])
        const bookedAt = new Date(dayStart.getTime() - 30 * HOUR)
        fleet.add(YOKO, { id: 'early', bookedAt, ended_at: new Date(dayStart.getTime() + HOUR).toISOString() })
        const snapshot = await confirm(runtime, { externalOrderId: 'early', providerBookedAt: bookedAt })
        expect(cashOrderConfirmationForOrderV1(snapshot, 'early')).toMatchObject({ state: 'confirmed', via: 'narrow' })
    })

    it('removes an order the narrow query positively disqualifies', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        const bookedAt = new Date(dayStart.getTime() + 5 * HOUR)
        fleet.add(YOKO, { id: 'o1', bookedAt })
        await confirm(runtime, { externalOrderId: 'o1', providerBookedAt: bookedAt })
        expect(store.order(YOKO, 'o1')).toBeDefined()
        fleet.update(YOKO, 'o1', { payment_method: 'cashless' })
        const snapshot = await confirm(runtime, { externalOrderId: 'o1', providerBookedAt: bookedAt })
        expect(cashOrderConfirmationForOrderV1(snapshot, 'o1')).toMatchObject({ state: 'removed', via: 'narrow' })
        expect(store.order(YOKO, 'o1')).toBeUndefined()
    })

    it('never removes an order whose narrow result is non-decisive', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        const bookedAt = new Date(dayStart.getTime() + 5 * HOUR)
        fleet.add(YOKO, { id: 'o1', bookedAt })
        await confirm(runtime, { externalOrderId: 'o1', providerBookedAt: bookedAt })
        fleet.update(YOKO, 'o1', { payment_method: null })
        const snapshot = await confirm(runtime, { externalOrderId: 'o1', providerBookedAt: bookedAt })
        expect(store.order(YOKO, 'o1')).toBeDefined()
        expect(snapshot?.outcome).toBe('complete')
    })

    it('joins a second order into the running record: narrow first, one shared fallback', async () => {
        const { runtime, fleet } = world('write', [YOKO])
        const bookedAt = new Date(dayStart.getTime() + 5 * HOUR)
        fleet.add(YOKO, { id: 'narrow', bookedAt })
        fleet.add(YOKO, { id: 'plain', bookedAt: new Date(dayStart.getTime() + 2 * HOUR) })
        expect((await runtime.requestDayConfirmation({ externalParkId: YOKO, dayKey: DAY, order: { externalOrderId: 'plain', providerBookedAt: null } })).status).toBe('scheduled')
        expect((await runtime.requestDayConfirmation({ externalParkId: YOKO, dayKey: DAY, order: { externalOrderId: 'narrow', providerBookedAt: bookedAt } })).status).toBe('joined')
        await settle(runtime.dayConfirmationSettled(YOKO, DAY))
        const snapshot = runtime.readDayConfirmation(YOKO, DAY)
        // The joined order's narrow query ran before any fallback slice.
        expect(fleet.requests[0].bookedTo.getTime() - fleet.requests[0].bookedFrom.getTime()).toBe(10 * MINUTE)
        expect(fleet.requests.slice(1).every((request) => request.bookedTo.getTime() - request.bookedFrom.getTime() > 10 * MINUTE)).toBe(true)
        expect(snapshot?.outcome).toBe('decided')
        expect(cashOrderConfirmationForOrderV1(snapshot, 'narrow')).toMatchObject({ state: 'confirmed' })
        expect(cashOrderConfirmationForOrderV1(snapshot, 'plain')).toMatchObject({ state: 'confirmed', via: 'fallback' })
    })

    it('ends incomplete at the 5 min deadline and never reports not_returned', async () => {
        const { runtime, fleet } = world('write', [YOKO])
        // Each tenure fits two 9.5 s pages of a three-page slice, so the slice
        // replays from its upper edge until the deadline.
        fleet.latencyMs = 9_500
        fleet.pageSize = 1
        for (let index = 0; index < 3; index += 1) fleet.add(YOKO, { id: `late${index}`, bookedAt: new Date(dayStart.getTime() + 22 * HOUR + index * MINUTE) })
        const snapshot = await confirm(runtime, { externalOrderId: 'o1', providerBookedAt: null })
        expect(snapshot?.outcome).toBe('incomplete')
        expect(cashOrderConfirmationForOrderV1(snapshot, 'o1').state).toBe('incomplete')
    })

    it('fails on a provider error and on an authority failure, never not_returned', async () => {
        const failing = world('write', [YOKO])
        failing.fleet.intercept = () => ({ ok: false, kind: 'http', status: 500, retryAfter: null })
        const provider = await confirm(failing.runtime, { externalOrderId: 'o1', providerBookedAt: null })
        expect(cashOrderConfirmationForOrderV1(provider, 'o1')).toMatchObject({ state: 'failed', code: 'provider_server_error' })

        const ambiguous = world('write', [YOKO])
        ambiguous.store.links.push(link(YOKO, { linkId: 'dup', apiConnectionId: 'conn-dup' }))
        const authority = await confirm(ambiguous.runtime, { externalOrderId: 'o1', providerBookedAt: null })
        expect(cashOrderConfirmationForOrderV1(authority, 'o1')).toMatchObject({ state: 'failed', code: 'ambiguous_active_connection' })
        expect(ambiguous.fleet.requests).toEqual([])
    })

    it('stops at the targeted page allowance', async () => {
        const { runtime, fleet } = world('write', [YOKO])
        fleet.pageSize = 1
        for (let index = 0; index < 40; index += 1) fleet.add(YOKO, { id: `o${index}`, bookedAt: new Date(dayStart.getTime() + index * 30 * MINUTE) })
        const snapshot = await confirm(runtime, { externalOrderId: 'missing', providerBookedAt: null })
        expect(snapshot?.outcome).toBe('failed:targeted_budget_exhausted')
        expect(fleet.requests).toHaveLength(30)
    })

    it('reports a record whose run never ends as lost after 6 min', async () => {
        const { runtime, store } = world('write', [YOKO])
        const release = await runtime.requestDayConfirmation({ externalParkId: YOKO, dayKey: DAY })
        expect(release.status).toBe('scheduled')
        store.hang = new Promise<never>(() => undefined)
        await advance(6 * MINUTE)
        expect(runtime.readDayConfirmation(YOKO, DAY)?.outcome).toBe('failed:lost')
    })

    it('never touches freshness, reconciliation or run status', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        fleet.add(YOKO, { id: 'o1', bookedAt: new Date(dayStart.getTime() + HOUR) })
        await confirm(runtime, { externalOrderId: 'o1', providerBookedAt: null })
        expect(store.progress(YOKO)).toEqual({
            lastHotSuccessAt: null,
            reconciliationPassStartedAt: null,
            reconciliationFloorBookedAt: null,
            reconciliationCursorBookedAt: null,
            lastReconciliationCompletedAt: null,
        })
        expect(store.checkpoints.get(YOKO)).toMatchObject({ lastRunStatus: null, consecutiveFailures: 0 })
        expect(store.checkpoints.get(YOKO)?.lastRunSummary?.targeted).toMatchObject({ target: 'day', dayKey: DAY, outcome: 'decided' })
    })

    it('gets its tenure between reconciliation slices of an active pass', async () => {
        const { runtime, store, fleet } = world('write', [YOKO])
        fleet.latencyMs = 3_000
        const tick = runtime.runTick()
        // Let the hot pass finish and reconciliation begin.
        await advance(10_000)
        fleet.add(YOKO, { id: 'o1', bookedAt: new Date(dayStart.getTime() + HOUR) })
        const scheduled = await runtime.requestDayConfirmation({ externalParkId: YOKO, dayKey: DAY, order: { externalOrderId: 'o1', providerBookedAt: null } })
        expect(scheduled.status).toBe('scheduled')
        await settle(runtime.dayConfirmationSettled(YOKO, DAY))
        const result = await settle(tick)
        expect(cashOrderConfirmationForOrderV1(runtime.readDayConfirmation(YOKO, DAY), 'o1')).toMatchObject({ state: 'confirmed' })
        expect(result.parks[0].reconciliation?.slices).toBeGreaterThan(0)
        expect(store.order(YOKO, 'o1')).toBeDefined()
    })
})

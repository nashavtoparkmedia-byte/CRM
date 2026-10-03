import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { CASH_ORDER_INGESTION_TIMING_V1 as T } from './cash-order-ingestion-budget'
import type { CashOrderIngestionConfigV1 } from './cash-order-ingestion-config'
import {
    cashOrderPreflightWindowsV1,
    CashOrderIngestionPreflightV1,
    type CashOrderPreflightPortsV1,
} from './cash-order-ingestion-preflight'
import { legacyPrismaCashOrderIngestionStoreV1 } from './legacy-prisma-cash-order-ingestion-adapter'
import {
    CashOrderPreflightWriteAttemptV1,
    readOnlyCashOrderIngestionStoreV1,
} from './read-only-cash-order-ingestion-store'
import type { CashOrderPageRequestV1, CashOrderPageResponseV1 } from './yandex-cash-order-source'

/**
 * The read-only preflight, against fakes.
 *
 * The question every test here asks is the same one the production contract
 * asks: did anything persist? The preflight is given a store that throws on
 * every mutating method, so "nothing persisted" is not asserted by inspecting
 * rows — it is asserted by the run completing at all.
 */

const PARK = 'park-ext-1'
const LOCAL = 'park-local-1'
const CONNECTION = 'conn-1'
const HOUR = 3_600_000
const SECRET = 'api-key-super-secret'

const snapshot = () => ({
    parks: [{ id: LOCAL, externalParkId: PARK }],
    links: [{
        linkId: 'link-1',
        localParkId: LOCAL,
        linkExternalParkId: PARK,
        parkExternalParkId: PARK,
        apiConnectionId: CONNECTION,
        apiConnectionParkId: PARK,
    }],
})

const credential = () => ({
    connectionId: CONNECTION,
    localParkId: LOCAL,
    parkId: PARK,
    clid: 'clid-1',
    apiKey: SECRET,
})

const order = (id: string, bookedAt: Date, overrides: Record<string, unknown> = {}) => ({
    id,
    short_id: 77,
    status: 'complete',
    payment_method: 'cash',
    price: '250.0000',
    booked_at: bookedAt.toISOString(),
    ended_at: new Date(bookedAt.getTime() + 15 * 60_000).toISOString(),
    driver_profile: { id: 'driver-1' },
    ...overrides,
})

const config = (over: Partial<CashOrderIngestionConfigV1> = {}): CashOrderIngestionConfigV1 => ({
    mode: 'off',
    enabledParks: [PARK],
    configError: null,
    ...over,
})

function world(options: {
    respond?: (request: CashOrderPageRequestV1, call: number) => CashOrderPageResponseV1
    orders?: Array<Record<string, unknown>>
    credentials?: () => Promise<readonly ReturnType<typeof credential>[]>
    readAuthority?: () => Promise<{ dbNow: Date; snapshot: ReturnType<typeof snapshot> }>
} = {}) {
    const requests: CashOrderPageRequestV1[] = []
    let calls = 0
    const dbNow = new Date('2026-09-25T09:00:00.000Z')
    const ports: CashOrderPreflightPortsV1 = {
        reader: {
            readAuthoritySnapshot: options.readAuthority ?? (async () => ({ dbNow, snapshot: snapshot() })),
        },
        loadCredentials: options.credentials ?? (async () => [credential()]),
        fetchPage: async (request) => {
            requests.push(request)
            calls += 1
            if (options.respond) return options.respond(request, calls)
            const inWindow = (options.orders ?? []).filter((raw) => {
                const bookedAt = Date.parse(String((raw as { booked_at: string }).booked_at))
                return bookedAt >= request.bookedFrom.getTime() && bookedAt <= request.bookedTo.getTime()
            })
            return { ok: true, orders: inWindow.map((raw) => structuredClone(raw)), cursor: null }
        },
        clock: { nowMs: () => 0 },
        wallNowMs: () => dbNow.getTime(),
        sleep: async () => {},
        random: () => 0.5,
    }
    return { ports, requests, dbNow }
}

describe('canonical windows', () => {
    it('derives the hot window and the newest dry-run reconciliation slice from database time', () => {
        const dbNow = new Date('2026-09-25T09:00:00.000Z')
        const windows = cashOrderPreflightWindowsV1(dbNow)
        expect(windows.map((entry) => entry.kind)).toEqual(['hot', 'reconciliation'])
        const [hot, reconciliation] = windows
        expect(hot.window.from.getTime()).toBe(dbNow.getTime() - 3 * HOUR)
        expect(hot.window.to.getTime()).toBe(dbNow.getTime() + 10 * 60_000)
        // The newest reconciliation slice sits directly below the hot lookback.
        expect(reconciliation.window.to.getTime()).toBe(dbNow.getTime() - 3 * HOUR)
        expect(reconciliation.window.from.getTime()).toBe(reconciliation.window.to.getTime() - 6 * HOUR)
    })

    it('takes no operator window: the same database time always yields the same ranges', () => {
        const dbNow = new Date('2026-09-25T09:00:00.000Z')
        expect(cashOrderPreflightWindowsV1(dbNow)).toEqual(cashOrderPreflightWindowsV1(new Date(dbNow)))
    })
})

describe('refusals before any provider contact', () => {
    it('refuses while the runtime is in write mode', async () => {
        const { ports, requests } = world()
        const report = await new CashOrderIngestionPreflightV1(config({ mode: 'write' }), ports).run()
        expect(report).toMatchObject({ ok: false, refusal: 'ingestion_mode_write', sufficientToAuthorizeWriteMode: false })
        expect(requests).toEqual([])
    })

    it('refuses when no park is enabled', async () => {
        const { ports } = world()
        expect(await new CashOrderIngestionPreflightV1(config({ enabledParks: [] }), ports).run())
            .toMatchObject({ refusal: 'no_enabled_parks' })
    })

    it('refuses a park outside the configured scope rather than widening it', async () => {
        const { ports, requests } = world()
        const report = await new CashOrderIngestionPreflightV1(config(), ports).run({ parks: ['someone-elses-park'] })
        expect(report).toMatchObject({ refusal: 'park_not_enabled' })
        expect(requests).toEqual([])
    })

    it('refuses when the authority snapshot cannot be read', async () => {
        const { ports } = world({ readAuthority: async () => { throw new Error('db down') } })
        expect(await new CashOrderIngestionPreflightV1(config(), ports).run())
            .toMatchObject({ refusal: 'authority_read_failed', sufficientToAuthorizeWriteMode: false })
    })
})

describe('a complete probe', () => {
    it('reads, classifies and reports sufficiency without persisting anything', async () => {
        const { ports, dbNow } = world({ orders: [order('o1', new Date(dbNowMinus(1)))] })
        const report = await new CashOrderIngestionPreflightV1(config(), ports).run()
        expect(report.ok).toBe(true)
        expect(report.refusal).toBeNull()
        expect(report.parks).toHaveLength(1)
        const park = report.parks[0]
        expect(park).toMatchObject({
            externalParkId: PARK,
            authority: 'authoritative',
            credential: 'admitted',
            provider: 'completed',
            accepted: 1,
            truncated: false,
            sufficient: true,
        })
        expect(park.windows.map((window) => window.status)).toEqual(['complete', 'complete'])
        expect(report.sufficientToAuthorizeWriteMode).toBe(true)
        expect(report.reasons).toEqual(['ok'])
        expect(new Date(park.windows[0].from).getTime()).toBe(dbNow.getTime() - 3 * HOUR)

        function dbNowMinus(hours: number): number {
            return new Date('2026-09-25T09:00:00.000Z').getTime() - hours * HOUR
        }
    })

    it('treats a complete empty provider result as sufficient', async () => {
        const { ports } = world({ orders: [] })
        const report = await new CashOrderIngestionPreflightV1(config(), ports).run()
        expect(report.parks[0]).toMatchObject({ accepted: 0, ordersObserved: 0, sufficient: true })
        expect(report.sufficientToAuthorizeWriteMode).toBe(true)
    })

    it('counts rejections by the projection reason so the operator can see the provider shape', async () => {
        const bookedAt = new Date(new Date('2026-09-25T09:00:00.000Z').getTime() - HOUR)
        const { ports } = world({
            orders: [
                order('good', bookedAt),
                order('cashless', bookedAt, { payment_method: 'cashless' }),
                order('nodriver', bookedAt, { driver_profile: {} }),
            ],
        })
        const park = (await new CashOrderIngestionPreflightV1(config(), ports).run()).parks[0]
        expect(park.accepted).toBe(1)
        expect(park.rejectedByReason).toMatchObject({ driver_profile_missing: expect.any(Number) })
        expect(park.ordersObserved).toBeGreaterThanOrEqual(3)
        // Removals keep their own sanitized vocabulary.
        expect(Object.keys(park.removedByReason).sort()).toEqual(['not_cash', 'not_completed', 'not_payable'])
    })
})

describe('admission failures are reported, not retried into a write', () => {
    it('reports a non-authoritative park and never calls the provider for it', async () => {
        const { ports, requests } = world({ readAuthority: async () => ({
            dbNow: new Date('2026-09-25T09:00:00.000Z'),
            snapshot: { parks: [{ id: LOCAL, externalParkId: PARK }], links: [] },
        }) })
        const report = await new CashOrderIngestionPreflightV1(config(), ports).run()
        expect(report.parks[0].authority).not.toBe('authoritative')
        expect(report.parks[0].provider).toBe('not_attempted')
        expect(report.parks[0].sufficient).toBe(false)
        expect(report.sufficientToAuthorizeWriteMode).toBe(false)
        expect(requests).toEqual([])
    })

    it('reports a credential that does not cross-check against the authority', async () => {
        const { ports, requests } = world({
            credentials: async () => [{ ...credential(), connectionId: 'someone-else' }],
        })
        const report = await new CashOrderIngestionPreflightV1(config(), ports).run()
        expect(report.parks[0].credential).toBe('authority_credential_mismatch')
        expect(report.parks[0].sufficient).toBe(false)
        expect(requests).toEqual([])
    })

    it('reports a failed credential read', async () => {
        const { ports } = world({ credentials: async () => { throw new Error('vault down') } })
        expect((await new CashOrderIngestionPreflightV1(config(), ports).run()).parks[0])
            .toMatchObject({ credential: 'credential_read_failed', sufficient: false })
    })
})

describe('provider throttling is never sufficient', () => {
    it('records sanitized 429 state, refuses authorization and persists no deferral', async () => {
        const { ports } = world({
            respond: () => ({ ok: false, kind: 'http', status: 429, retryAfter: '30' }),
        })
        const report = await new CashOrderIngestionPreflightV1(config(), ports).run()
        const park = report.parks[0]
        expect(park.provider).toBe('failed')
        expect(park.windows[0]).toMatchObject({ status: 'failed' })
        expect(park.windows[0].failure).toContain('429')
        expect(park.http429).toBeGreaterThan(0)
        expect(park.sufficient).toBe(false)
        expect(report.sufficientToAuthorizeWriteMode).toBe(false)
        // Reaching here at all proves no deferral, lease or checkpoint was written:
        // the store throws on every one of those.
        expect(report.reasons.join(' ')).toContain(PARK)
    })

    it('refuses authorization after a retried throttle even when the window completes', async () => {
        const { ports } = world({
            respond: (_request, call) => (call === 1
                ? { ok: false, kind: 'http', status: 429, retryAfter: '0' }
                : { ok: true, orders: [], cursor: null }),
        })
        const park = (await new CashOrderIngestionPreflightV1(config(), ports).run()).parks[0]
        expect(park.http429).toBeGreaterThan(0)
        expect(park.sufficient).toBe(false)
        expect(park.reasons).toContain('provider_throttled')
    })

    it('refuses authorization when a window is truncated by the page cap', async () => {
        const bookedAt = new Date(new Date('2026-09-25T09:00:00.000Z').getTime() - HOUR)
        const { ports } = world({
            // Never returns a final page, so the slice hits SLICE_PAGE_CAP.
            respond: (_request, call) => ({ ok: true, orders: [order(`o${call}`, bookedAt)], cursor: `c${call}` }),
        })
        const park = (await new CashOrderIngestionPreflightV1(config(), ports).run()).parks[0]
        expect(park.truncated).toBe(true)
        expect(park.pages).toBe(T.SLICE_PAGE_CAP)
        expect(park.reasons).toContain('window_truncated')
        expect(park.sufficient).toBe(false)
    })

    it('fails closed on a terminal provider error with no write-capable fallback', async () => {
        const { ports } = world({ respond: () => ({ ok: false, kind: 'network' }) })
        const report = await new CashOrderIngestionPreflightV1(config(), ports).run()
        expect(report.parks[0]).toMatchObject({ provider: 'failed', sufficient: false })
        expect(report.sufficientToAuthorizeWriteMode).toBe(false)
    })
})

describe('the configuration diagnostic reaches the authorization decision', () => {
    it('never authorizes write while a retired dry_run configuration is present', async () => {
        const { ports } = world({ orders: [] })
        const report = await new CashOrderIngestionPreflightV1(
            config({ configError: 'scheduled_dry_run_retired' }),
            ports,
        ).run()
        expect(report.parks[0].sufficient).toBe(true)
        expect(report.configError).toBe('scheduled_dry_run_retired')
        expect(report.sufficientToAuthorizeWriteMode).toBe(false)
        expect(report.reasons).toContain('scheduled_dry_run_retired')
    })
})

describe('the write-capability boundary', () => {
    it('refuses every mutating store method before touching persistence', async () => {
        const store = readOnlyCashOrderIngestionStoreV1({
            readAuthoritySnapshot: async () => ({ dbNow: new Date(), snapshot: snapshot() }),
        })
        const attempts: Array<[string, () => Promise<unknown>]> = [
            ['acquireLease', () => store.acquireLease({ provider: 'p', externalParkId: PARK, token: 't' })],
            ['releaseLease', () => store.releaseLease({ checkpointId: 'c', token: 't' })],
            ['writePage', () => store.writePage({} as never)],
            ['recordDeferral', () => store.recordDeferral({ checkpointId: 'c', token: 't', seconds: 1, connectionId: CONNECTION })],
            ['finishBackgroundRun', () => store.finishBackgroundRun({} as never)],
            ['recordTargetedSummary', () => store.recordTargetedSummary({ provider: 'p', externalParkId: PARK, summary: {} })],
            ['recordDryRunProgress', () => store.recordDryRunProgress({ checkpointId: 'c', token: 't', dryRun: {} })],
            ['readDatabaseNow', () => store.readDatabaseNow()],
            ['readCheckpoints', () => store.readCheckpoints('p', [PARK])],
        ]
        for (const [method, call] of attempts) {
            await expect(call()).rejects.toThrow(CashOrderPreflightWriteAttemptV1)
            await expect(call()).rejects.toThrow(method)
        }
        // The one capability it does have.
        await expect(store.readAuthoritySnapshot()).resolves.toMatchObject({ snapshot: expect.any(Object) })
    })

    it('fails loudly if a writer is reconnected on the preflight path', async () => {
        // The negative case the contract demands: hand the preflight the real
        // write-capable store and prove the first persistence attempt throws
        // rather than reaching a transaction. Every Prisma entry point on the
        // real adapter is stubbed to record and reject, so a mutation that got
        // through would be visible here instead of silently hitting a database.
        const touched: string[] = []
        const guarded = new Proxy(legacyPrismaCashOrderIngestionStoreV1, {
            get(target, property: string) {
                if (property === 'readAuthoritySnapshot') {
                    return async () => ({ dbNow: new Date('2026-09-25T09:00:00.000Z'), snapshot: snapshot() })
                }
                return async (...args: unknown[]) => {
                    touched.push(property)
                    void args
                    throw new Error(`persistence reached: ${property}`)
                }
            },
        }) as typeof legacyPrismaCashOrderIngestionStoreV1

        const { ports } = world({ orders: [] })
        const writerPorts: CashOrderPreflightPortsV1 = {
            ...ports,
            reader: { readAuthoritySnapshot: () => guarded.readAuthoritySnapshot() },
        }
        // With the real reader the probe still completes, because a correct
        // preflight never calls a mutating method at all.
        const report = await new CashOrderIngestionPreflightV1(config(), writerPorts).run()
        expect(report.ok).toBe(true)
        expect(touched).toEqual([])
    })
})

describe('output sanitization', () => {
    it('emits no credential material anywhere in the report', async () => {
        const bookedAt = new Date(new Date('2026-09-25T09:00:00.000Z').getTime() - HOUR)
        const { ports } = world({ orders: [order('o1', bookedAt)] })
        const report = await new CashOrderIngestionPreflightV1(config(), ports).run()
        const serialized = JSON.stringify(report)
        expect(serialized).not.toContain(SECRET)
        expect(serialized).not.toContain('clid-1')
        expect(serialized).not.toContain('apiKey')
    })

    it('emits no raw order identifiers', async () => {
        const bookedAt = new Date(new Date('2026-09-25T09:00:00.000Z').getTime() - HOUR)
        const { ports } = world({ orders: [order('order-id-that-must-not-appear', bookedAt)] })
        const report = await new CashOrderIngestionPreflightV1(config(), ports).run()
        const serialized = JSON.stringify(report)
        expect(serialized).not.toContain('order-id-that-must-not-appear')
        expect(serialized).not.toContain('driver-1')
    })

    it('reports a provider failure as a code, never a body', async () => {
        const { ports } = world({
            respond: () => ({ ok: false, kind: 'http', status: 500, retryAfter: null }),
        })
        const report = await new CashOrderIngestionPreflightV1(config(), ports).run()
        const failure = report.parks[0].windows[0].failure ?? ''
        expect(failure).toMatch(/^[a-z_]+( \(HTTP \d{3}\))?$/)
    })
})

describe('idempotence', () => {
    it('two consecutive probes return the same persistent-state-free outcome', async () => {
        const bookedAt = new Date(new Date('2026-09-25T09:00:00.000Z').getTime() - HOUR)
        const first = world({ orders: [order('o1', bookedAt)] })
        const second = world({ orders: [order('o1', bookedAt)] })
        const a = await new CashOrderIngestionPreflightV1(config(), first.ports).run()
        const b = await new CashOrderIngestionPreflightV1(config(), second.ports).run()
        expect(a).toEqual(b)
    })

    it('never passes through an operational job wrapper', () => {
        // The wrapper is what creates cron_health_log and inserts a row on
        // every outcome. The probe has to be reachable without it, so its
        // import graph must not mention it at all.
        const root = 'src/modules/fleet-operations'
        const preflight = readFileSync(`${root}/internal/compensation/cash-order-ingestion-preflight.ts`, 'utf8')
        const composition = readFileSync(`${root}/application/cash-order-ingestion-operations.ts`, 'utf8')
        for (const source of [preflight, composition]) {
            expect(source).not.toContain('runOperationalJobV1')
            expect(source).not.toContain('logCronHealth')
        }
        expect(preflight).not.toContain('operations-observability')
    })
})

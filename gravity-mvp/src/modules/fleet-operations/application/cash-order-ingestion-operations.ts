/**
 * Composition root for cash-order ingestion.
 *
 * The scheduler, a targeted hot refresh and a targeted day confirmation all
 * reach the one runtime built here, so no caller chooses its own adapter,
 * credential source or provider client. Configuration is read once per
 * process: changing the mode or the enabled parks takes a restart, and mode
 * `off` (the default) makes every operation below a no-op.
 *
 * Every export returns an explicit DTO. Nothing that holds the store, a
 * credential or a provider response crosses this file.
 */

import { randomUUID } from 'node:crypto'

import { cashOrderIngestionTickScheduleV1 } from '../internal/compensation/cash-order-ingestion-budget'
import {
    parseCashOrderIngestionConfigV1,
    parseCashOrderIngestionModeV1,
} from '../internal/compensation/cash-order-ingestion-config'
import {
    cashOrderConfirmationForOrderV1,
    CashOrderIngestionRuntimeV1,
} from '../internal/compensation/cash-order-ingestion-runtime'
import { classifyCashOrderParkAuthorityV1 } from '../internal/compensation/cash-order-park-authority'
import { CASH_ORDER_PROVIDER_V1 } from '../internal/compensation/cash-order-ingestion-store'
import { legacyPrismaCashOrderIngestionStoreV1 } from '../internal/compensation/legacy-prisma-cash-order-ingestion-adapter'
import { loadYandexCashOrderCredentialsV1 } from '../internal/compensation/yandex-cash-order-credentials'
import { createYandexCashOrderPageFetcherV1 } from '../internal/compensation/yandex-cash-order-source'

const config = parseCashOrderIngestionConfigV1({
    mode: process.env.YOKO_CASH_ORDER_INGESTION_MODE,
    parks: process.env.YOKO_CASH_COMPENSATION_PARKS,
})

// Built once at load, with no I/O: the store, credential source and provider
// client are only used when a tick or a targeted request runs.
const runtime = new CashOrderIngestionRuntimeV1(
    config,
    {
        store: legacyPrismaCashOrderIngestionStoreV1,
        loadCredentials: loadYandexCashOrderCredentialsV1,
        fetchPage: createYandexCashOrderPageFetcherV1(),
        clock: { nowMs: () => performance.now() },
        wallNowMs: () => Date.now(),
        sleep: (durationMs) => new Promise((resolve) => {
            setTimeout(resolve, durationMs).unref?.()
        }),
        random: Math.random,
        newToken: () => randomUUID(),
        // Fields are codes and park ids only; never a body or a credential.
        log: (level, event, fields) => console[level](JSON.stringify({ event, ...fields })),
    },
)

export interface CashOrderIngestionScheduleV1 {
    enabled: boolean
    intervalMs: number
    firstRunDelayMs: number
}

/** Whether the scheduler should register at all. Mode off registers nothing. */
export function cashOrderIngestionScheduleV1(): CashOrderIngestionScheduleV1 {
    const mode = parseCashOrderIngestionModeV1(process.env.YOKO_CASH_ORDER_INGESTION_MODE)
    const tick = cashOrderIngestionTickScheduleV1()
    return {
        enabled: mode !== 'off',
        intervalMs: tick.intervalMs,
        firstRunDelayMs: tick.firstRunDelayMs,
    }
}

export interface ScheduledCashOrderIngestionResultV1 {
    mode: string
    parks: Array<{
        externalParkId: string
        hot: string
        hotCode: string | null
        reconciliation: string | null
        pages: number
        alarms: string[]
    }>
}

/**
 * One background tick. Throws a compact error naming the failing parks and
 * codes when the tick has any job error, so the operational job records it.
 */
export async function runScheduledCashOrderIngestionV1(): Promise<ScheduledCashOrderIngestionResultV1> {
    const result = await runtime.runTick()
    if (result.errors.length > 0) {
        throw new Error(`cash_order_ingestion_failed: ${result.errors.slice(0, 12).join(', ')}`)
    }
    return {
        mode: result.mode,
        parks: result.parks.map((park) => ({
            externalParkId: park.externalParkId,
            hot: park.hot.status,
            hotCode: park.hot.code,
            reconciliation: park.reconciliation === null ? null : park.reconciliation.status,
            pages: park.hot.counters.pages + (park.reconciliation === null ? 0 : park.reconciliation.counters.pages),
            alarms: [...park.alarms],
        })),
    }
}

export interface CashOrderRefreshRequestV1 {
    status: 'scheduled' | 'joined' | 'not_scheduled'
    reason: string | null
}

/** Schedules one hot refresh of an enabled park. Never waits for the provider. */
export async function requestCashOrderHotRefreshV1(externalParkId: string): Promise<CashOrderRefreshRequestV1> {
    const outcome = await runtime.requestHotRefresh(externalParkId)
    return outcome.status === 'not_scheduled'
        ? { status: 'not_scheduled', reason: outcome.reason }
        : { status: outcome.status, reason: null }
}

/**
 * Schedules, or joins, confirmation of an enabled park's business day
 * (`YYYY-MM-DD`, Asia/Yekaterinburg), optionally for one order. Never waits
 * for the provider.
 */
export async function requestCashOrderDayConfirmationV1(input: {
    externalParkId: string
    dayKey: string
    order?: { externalOrderId: string; providerBookedAt: Date | null }
}): Promise<CashOrderRefreshRequestV1> {
    const outcome = await runtime.requestDayConfirmation({
        externalParkId: input.externalParkId,
        dayKey: input.dayKey,
        order: input.order === undefined
            ? undefined
            : { externalOrderId: input.order.externalOrderId, providerBookedAt: input.order.providerBookedAt },
    })
    return outcome.status === 'not_scheduled'
        ? { status: 'not_scheduled', reason: outcome.reason }
        : { status: outcome.status, reason: null }
}

export interface CashOrderOrderConfirmationDtoV1 {
    state: 'running' | 'confirmed' | 'removed' | 'not_returned' | 'incomplete' | 'failed' | 'undetermined'
    via: 'narrow' | 'fallback' | null
    connectionId: string | null
    startedAt: Date | null
    endedAt: Date | null
    code: string | null
}

/**
 * What this process's day confirmation established about one order. Only a
 * complete fallback reports `not_returned`; incomplete and failed records never
 * do. Database times only.
 */
export function readCashOrderOrderConfirmationV1(input: {
    externalParkId: string
    dayKey: string
    externalOrderId: string
}): CashOrderOrderConfirmationDtoV1 {
    const snapshot = runtime.readDayConfirmation(input.externalParkId, input.dayKey)
    const confirmation = cashOrderConfirmationForOrderV1(snapshot, input.externalOrderId)
    switch (confirmation.state) {
        case 'confirmed':
        case 'removed':
            return { state: confirmation.state, via: confirmation.via, connectionId: confirmation.connectionId, startedAt: null, endedAt: null, code: null }
        case 'not_returned':
            return { state: 'not_returned', via: null, connectionId: confirmation.connectionId, startedAt: confirmation.startDb, endedAt: confirmation.endedDb, code: null }
        case 'incomplete':
            return { state: 'incomplete', via: null, connectionId: null, startedAt: null, endedAt: confirmation.endedDb, code: null }
        case 'failed':
            return { state: 'failed', via: null, connectionId: null, startedAt: null, endedAt: confirmation.endedDb, code: confirmation.code }
        default:
            return { state: confirmation.state, via: null, connectionId: null, startedAt: null, endedAt: null, code: null }
    }
}

export interface CashOrderCatalogueFactsDtoV1 {
    mode: 'off' | 'dry_run' | 'write'
    /** Enabled for ingestion, with a valid park configuration. */
    parkEnabled: boolean
    dbNow: Date
    lastHotSuccessAt: Date | null
    reconciliationPassStartedAt: Date | null
    reconciliationFloorBookedAt: Date | null
    reconciliationCursorBookedAt: Date | null
    lastReconciliationCompletedAt: Date | null
}

/**
 * How complete one park's local catalogue is, from its checkpoint row and this
 * process's configuration. One short database operation; no provider call and
 * no credential.
 */
export async function readCashOrderCatalogueFactsV1(externalParkId: string): Promise<CashOrderCatalogueFactsDtoV1> {
    const read = await legacyPrismaCashOrderIngestionStoreV1.readCheckpoints(CASH_ORDER_PROVIDER_V1, [externalParkId])
    const checkpoint = read.checkpoints.find((candidate) => candidate.externalParkId === externalParkId) ?? null
    return {
        mode: config.mode,
        parkEnabled: config.configError === null && config.enabledParks.includes(externalParkId),
        dbNow: read.dbNow,
        lastHotSuccessAt: checkpoint === null ? null : checkpoint.lastHotSuccessAt,
        reconciliationPassStartedAt: checkpoint === null ? null : checkpoint.reconciliationPassStartedAt,
        reconciliationFloorBookedAt: checkpoint === null ? null : checkpoint.reconciliationFloorBookedAt,
        reconciliationCursorBookedAt: checkpoint === null ? null : checkpoint.reconciliationCursorBookedAt,
        lastReconciliationCompletedAt: checkpoint === null ? null : checkpoint.lastReconciliationCompletedAt,
    }
}

export type CashOrderParkAuthorityDtoV1 =
    | { status: 'authoritative'; connectionId: string }
    | { status: 'failed'; code: string }

/**
 * The park authority ingestion itself uses, read from connection metadata
 * only: no credential is loaded. One short database operation.
 */
export async function readCashOrderParkAuthorityV1(externalParkId: string): Promise<CashOrderParkAuthorityDtoV1> {
    const read = await legacyPrismaCashOrderIngestionStoreV1.readAuthoritySnapshot()
    const authority = classifyCashOrderParkAuthorityV1(externalParkId, read.snapshot)
    return authority.status === 'authoritative'
        ? { status: 'authoritative', connectionId: authority.connectionId }
        : { status: 'failed', code: authority.code }
}

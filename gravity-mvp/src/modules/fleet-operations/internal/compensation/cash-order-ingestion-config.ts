/**
 * Runtime configuration for cash-order ingestion.
 *
 * YOKO_CASH_ORDER_INGESTION_MODE selects what the runtime may do:
 *
 *   off      no provider request and no write from any trigger (the default,
 *            and what an empty or unknown value means)
 *   dry_run  fetch and classify; never write an order, freshness or
 *            reconciliation progress, and run no targeted refresh
 *   write    every trigger, full catalogue writes
 *
 * YOKO_CASH_COMPENSATION_PARKS lists the compensation-enabled external park
 * ids, comma separated. It is both the ingestion scope and product
 * enablement, and it is capped at three parks.
 */

import { CASH_ORDER_INGESTION_TIMING_V1 as T } from './cash-order-ingestion-budget'

export const CASH_ORDER_INGESTION_MODES_V1 = ['off', 'dry_run', 'write'] as const
export type CashOrderIngestionModeV1 = typeof CASH_ORDER_INGESTION_MODES_V1[number]

export interface CashOrderIngestionConfigV1 {
    mode: CashOrderIngestionModeV1
    enabledParks: readonly string[]
    configError: 'enabled_park_limit_exceeded' | null
}

export function parseCashOrderIngestionModeV1(value: string | undefined): CashOrderIngestionModeV1 {
    const trimmed = (value ?? '').trim()
    return (CASH_ORDER_INGESTION_MODES_V1 as readonly string[]).includes(trimmed)
        ? trimmed as CashOrderIngestionModeV1
        : 'off'
}

export function parseCashOrderIngestionConfigV1(env: {
    mode: string | undefined
    parks: string | undefined
}): CashOrderIngestionConfigV1 {
    const mode = parseCashOrderIngestionModeV1(env.mode)
    const enabledParks = [...new Set((env.parks ?? '')
        .split(',')
        .map((park) => park.trim())
        .filter((park) => park !== ''))]
    // Too many parks is a configuration failure for every park, not a silent
    // truncation to the first three.
    if (enabledParks.length > T.MAX_ENABLED_PARKS) {
        return { mode, enabledParks, configError: 'enabled_park_limit_exceeded' }
    }
    return { mode, enabledParks, configError: null }
}

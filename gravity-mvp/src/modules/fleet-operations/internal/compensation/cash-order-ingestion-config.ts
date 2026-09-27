/**
 * Runtime configuration for cash-order ingestion.
 *
 * YOKO_CASH_ORDER_INGESTION_MODE selects what the scheduled runtime may do:
 *
 *   off      no provider request and no write from any trigger (the default,
 *            and what an empty, unknown or retired value means)
 *   write    every trigger, full catalogue writes
 *
 * `dry_run` was once a third scheduled mode. It is retired: it was never
 * read-only. A scheduled dry run still created its checkpoint row, took and
 * released a lease, wrote its own progress, run status and error state, could
 * persist a provider deferral, and — through the generic operational job
 * wrapper — created the cron health table and inserted a row. It therefore
 * could not answer the only question a production preflight is asked, which is
 * whether reading is safe before anything is allowed to write.
 *
 * The authorization probe is now an explicit one-shot read-only preflight that
 * holds no write capability at all; see cash-order-ingestion-preflight.ts. The
 * release sequence is off → preflight → write.
 *
 * A configuration that still says `dry_run` fails closed: the mode resolves to
 * `off`, so nothing is scheduled and nothing can write, and the configuration
 * carries `scheduled_dry_run_retired` so the operator is told why rather than
 * being left to wonder at a silent `off`. It can never resolve to `write`.
 *
 * YOKO_CASH_COMPENSATION_PARKS lists the compensation-enabled external park
 * ids, comma separated. It is both the ingestion scope and product
 * enablement, and it is capped at three parks.
 */

import { CASH_ORDER_INGESTION_TIMING_V1 as T } from './cash-order-ingestion-budget'

export const CASH_ORDER_INGESTION_MODES_V1 = ['off', 'write'] as const
export type CashOrderIngestionModeV1 = typeof CASH_ORDER_INGESTION_MODES_V1[number]

/** Values that once selected a scheduled mode and now fail closed. */
export const RETIRED_CASH_ORDER_INGESTION_MODES_V1 = ['dry_run'] as const
export type RetiredCashOrderIngestionModeV1 = typeof RETIRED_CASH_ORDER_INGESTION_MODES_V1[number]

export type CashOrderIngestionConfigErrorV1 =
    | 'enabled_park_limit_exceeded'
    | 'scheduled_dry_run_retired'

export interface CashOrderIngestionConfigV1 {
    mode: CashOrderIngestionModeV1
    enabledParks: readonly string[]
    configError: CashOrderIngestionConfigErrorV1 | null
}

export function isRetiredCashOrderIngestionModeV1(value: string | undefined): boolean {
    return (RETIRED_CASH_ORDER_INGESTION_MODES_V1 as readonly string[]).includes((value ?? '').trim())
}

/** Anything not an active mode — retired, unknown or empty — resolves to off. */
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
    // Reported after the park limit so a deployment with both faults still sees
    // the one that silently disables every park.
    if (isRetiredCashOrderIngestionModeV1(env.mode)) {
        return { mode, enabledParks, configError: 'scheduled_dry_run_retired' }
    }
    return { mode, enabledParks, configError: null }
}

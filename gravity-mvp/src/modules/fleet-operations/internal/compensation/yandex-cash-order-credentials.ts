/**
 * The one place cash-order ingestion reads Yandex credentials.
 *
 * The capability is called unchanged. Every other ingestion module receives
 * the entries through a port, so tests never touch it and the reviewed
 * consumer edge stays a single file. Overlapping callers join the call already
 * in flight instead of starting a second read of the same secrets.
 */

import {
    listYandexConnectionCredentialsV1,
    type YandexConnectionCredentialsV1,
} from '../../public/v1/yandex-connection-capability'

let inFlight: Promise<YandexConnectionCredentialsV1[]> | null = null

export function loadYandexCashOrderCredentialsV1(): Promise<YandexConnectionCredentialsV1[]> {
    if (inFlight === null) {
        inFlight = listYandexConnectionCredentialsV1().finally(() => {
            inFlight = null
        })
    }
    return inFlight
}

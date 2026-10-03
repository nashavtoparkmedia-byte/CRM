/**
 * How Fleet learns which park a driver's Telegram bot link is on.
 *
 * Fleet may not read Telegram channel state, and the manifest graph is acyclic:
 * telegram_channel depends on fleet_operations.public, so the reverse import
 * cannot exist. So Fleet declares the seam and the composition binds Telegram's
 * own public read into it, exactly as the Yandex reconciliation runner is bound
 * from Platform Shell during bootstrap.
 *
 * The seam is as narrow as the fact it carries: driver ids in, park per linked
 * driver out. No Telegram user id, username, submitted phone or bot state can
 * reach Fleet through it, and a driver with no link is simply absent from the
 * answer rather than being described.
 */

/** Only the queried drivers that have a link; absence means no link at all. */
export type CompensationPilotTelegramLinkV1 = {
    driverId: string
    activeParkId: string | null
}

export type CompensationPilotTelegramLinkReaderV1 = (
    driverIds: readonly string[],
) => Promise<readonly CompensationPilotTelegramLinkV1[]>

declare global {
    // The readiness composition supplies Telegram's public read once per
    // process. Fleet owns the seam and snapshots it per readiness run.
    var __compensationPilotTelegramLinkReaderV1: CompensationPilotTelegramLinkReaderV1 | undefined
}

/**
 * Bind the reader without introducing a Fleet -> Telegram channel import.
 * Registration is stable and idempotent for the same function; a competing
 * composition fails closed rather than silently replacing the reader.
 */
export function registerCompensationPilotTelegramLinkReaderV1(
    reader: CompensationPilotTelegramLinkReaderV1,
): () => void {
    if (typeof reader !== 'function') throw new TypeError('reader must be a function')
    const existing = globalThis.__compensationPilotTelegramLinkReaderV1
    if (existing && existing !== reader) {
        throw new Error('COMPENSATION_PILOT_TELEGRAM_LINK_READER_ALREADY_REGISTERED')
    }
    globalThis.__compensationPilotTelegramLinkReaderV1 = reader
    return () => {
        if (globalThis.__compensationPilotTelegramLinkReaderV1 === reader) {
            globalThis.__compensationPilotTelegramLinkReaderV1 = undefined
        }
    }
}

/**
 * No fallback: a readiness answer built without the Telegram link would report
 * every candidate as unlinked, which reads as a data problem rather than as the
 * missing composition it is.
 */
export function requireCompensationPilotTelegramLinkReaderV1(): CompensationPilotTelegramLinkReaderV1 {
    const reader = globalThis.__compensationPilotTelegramLinkReaderV1
    if (!reader) throw new Error('COMPENSATION_PILOT_TELEGRAM_LINK_READER_NOT_REGISTERED')
    return reader
}

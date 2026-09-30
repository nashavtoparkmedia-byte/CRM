/**
 * The one read Telegram channel publishes about a driver's bot link.
 *
 * It answers a single question asked by owners of a driver population: which of
 * these drivers have a bot link, and which park is active on it. Nothing else
 * about the link crosses the boundary — not the Telegram user id, not the
 * username, not the submitted phone, not the bot state — so a consumer can
 * correlate a park without being handed the driver's Telegram identity.
 *
 * The query is bounded by construction: a caller names the drivers it already
 * holds, and an unbounded enumeration of the link table is not expressible.
 */

export const READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1 =
    'telegram_channel.ReadDriverTelegramParkLinksQuery.v1' as const
export const READ_DRIVER_TELEGRAM_PARK_LINKS_RESULT_V1 =
    'telegram_channel.ReadDriverTelegramParkLinksResult.v1' as const

/** One query may name at most this many drivers. */
export const READ_DRIVER_TELEGRAM_PARK_LINKS_MAX_DRIVER_IDS_V1 = 500

export interface ReadDriverTelegramParkLinksQueryV1 {
    contract: typeof READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1
    driverIds: readonly string[]
}

/** A link that exists. `activeParkId` is null when the driver has chosen no park. */
export interface DriverTelegramParkLinkV1 {
    driverId: string
    activeParkId: string | null
}

export interface ReadDriverTelegramParkLinksResultV1 {
    contract: typeof READ_DRIVER_TELEGRAM_PARK_LINKS_RESULT_V1
    /** Only the queried drivers that have a link; absence means no link. */
    links: readonly DriverTelegramParkLinkV1[]
}

export class DriverTelegramParkLinkQueryValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
    constructor(code: DriverTelegramParkLinkQueryValidationError['code'], message: string) {
        super(message)
        this.name = 'DriverTelegramParkLinkQueryValidationError'
        this.code = code
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

function invalid(message: string): never {
    throw new DriverTelegramParkLinkQueryValidationError('INVALID_CONTRACT', message)
}

export function parseReadDriverTelegramParkLinksQueryV1(
    input: unknown,
): ReadDriverTelegramParkLinksQueryV1 {
    if (!isRecord(input)) invalid('query must be an object')
    const fields = ['contract', 'driverIds']
    const extra = Object.keys(input).filter((key) => !fields.includes(key))
    if (extra.length) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
    if (input.contract !== READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1) {
        if (
            typeof input.contract === 'string'
            && input.contract.startsWith('telegram_channel.ReadDriverTelegramParkLinksQuery.')
        ) {
            throw new DriverTelegramParkLinkQueryValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1}`)
    }
    if (!Array.isArray(input.driverIds)) invalid('driverIds must be an array')
    if (input.driverIds.length === 0) invalid('driverIds must not be empty')
    if (input.driverIds.length > READ_DRIVER_TELEGRAM_PARK_LINKS_MAX_DRIVER_IDS_V1) {
        invalid(`driverIds must name at most ${READ_DRIVER_TELEGRAM_PARK_LINKS_MAX_DRIVER_IDS_V1} drivers`)
    }
    for (const driverId of input.driverIds) {
        if (typeof driverId !== 'string' || driverId.trim() === '') invalid('driverIds entries are required')
    }
    return input as unknown as ReadDriverTelegramParkLinksQueryV1
}

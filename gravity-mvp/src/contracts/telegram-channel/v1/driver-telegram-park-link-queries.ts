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

/**
 * telegram.BotLinkStatusQuery.v1: is a driver/Telegram bot link STORED.
 *
 * DISPLAY-ONLY. It answers, for ids the caller already holds, whether a
 * DriverTelegram link row exists, for a person card's «ТГ-бот» column. It grants
 * nothing and must not be used for any access decision (Cash, referral or any
 * other): those bind a driver through the exact Telegram action binding and
 * Contacts' provider-bound identity, never through this status. Nothing else
 * about the link crosses: no counterpart id, name, phone, username or bot state.
 */
export const BOT_LINK_STATUS_QUERY_V1 = 'telegram.BotLinkStatusQuery.v1' as const

/** One query may name at most this many Telegram ids and this many driver ids. */
export const BOT_LINK_STATUS_MAX_IDS_V1 = 200

export type DriverTelegramLinkStoredStatusV1 = 'link_stored' | 'no_link_stored' | 'unknown'

export interface BotLinkStatusQueryV1 {
    contract: typeof BOT_LINK_STATUS_QUERY_V1
    telegramIds?: readonly string[]
    driverIds?: readonly string[]
}

export interface BotLinkStatusResultV1 {
    /** One entry per distinct queried Telegram id. */
    byTelegramId: Readonly<Record<string, DriverTelegramLinkStoredStatusV1>>
    /** One entry per distinct queried driver id. */
    byDriverId: Readonly<Record<string, DriverTelegramLinkStoredStatusV1>>
}

/** A Telegram user id this query can look up: a positive decimal that fits a BigInt column. */
export function isQueryableTelegramUserIdV1(value: string): boolean {
    return /^[1-9]\d{0,18}$/u.test(value)
}

/** A driver id this query can look up: a non-empty, trimmed, bounded string. */
export function isQueryableDriverIdV1(value: string): boolean {
    return value.length > 0 && value.length <= 128 && value === value.trim()
}

export function parseBotLinkStatusQueryV1(input: unknown): BotLinkStatusQueryV1 {
    if (!isRecord(input)) invalid('query must be an object')
    const fields = ['contract', 'telegramIds', 'driverIds']
    const extra = Object.keys(input).filter((key) => !fields.includes(key))
    if (extra.length) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
    if (input.contract !== BOT_LINK_STATUS_QUERY_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('telegram.BotLinkStatusQuery.')) {
            throw new DriverTelegramParkLinkQueryValidationError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${input.contract}`)
        }
        invalid(`contract must equal ${BOT_LINK_STATUS_QUERY_V1}`)
    }
    for (const field of ['telegramIds', 'driverIds'] as const) {
        const ids = input[field]
        if (ids === undefined) continue
        if (!Array.isArray(ids)) invalid(`${field} must be an array`)
        if (ids.length > BOT_LINK_STATUS_MAX_IDS_V1) invalid(`${field} must name at most ${BOT_LINK_STATUS_MAX_IDS_V1} ids`)
        // A malformed id is not a contract error: it is answered 'unknown'.
        for (const id of ids) if (typeof id !== 'string') invalid(`${field} entries must be strings`)
    }
    return input as unknown as BotLinkStatusQueryV1
}

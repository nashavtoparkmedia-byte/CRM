import {
    READ_DRIVER_TELEGRAM_PARK_LINKS_RESULT_V1,
    isQueryableDriverIdV1,
    isQueryableTelegramUserIdV1,
    parseBotLinkStatusQueryV1,
    parseReadDriverTelegramParkLinksQueryV1,
    type BotLinkStatusQueryV1,
    type BotLinkStatusResultV1,
    type DriverTelegramLinkStoredStatusV1,
    type DriverTelegramParkLinkV1,
    type ReadDriverTelegramParkLinksQueryV1,
    type ReadDriverTelegramParkLinksResultV1,
} from '../../../../contracts/telegram-channel/v1'

/**
 * The read side of the driver link, kept deliberately smaller than the write
 * port next to it: one lookup, two fields out, no way to ask for a link the
 * caller cannot already name.
 */
export interface DriverTelegramParkLinkReadPortV1 {
    findParkLinks(driverIds: readonly string[]): Promise<readonly DriverTelegramParkLinkV1[]>
}

export function createReadDriverTelegramParkLinksHandlerV1(port: DriverTelegramParkLinkReadPortV1) {
    return async function readDriverTelegramParkLinksV1(
        query: ReadDriverTelegramParkLinksQueryV1 | unknown,
    ): Promise<ReadDriverTelegramParkLinksResultV1> {
        const parsed = parseReadDriverTelegramParkLinksQueryV1(query)
        const found = await port.findParkLinks([...new Set(parsed.driverIds)])
        // Projected field by field, so a port that returns a wider row cannot
        // widen this contract by accident.
        return {
            contract: READ_DRIVER_TELEGRAM_PARK_LINKS_RESULT_V1,
            links: found.map((link) => ({ driverId: link.driverId, activeParkId: link.activeParkId })),
        }
    }
}

/** The read side for telegram.BotLinkStatusQuery.v1: which of these ids have a stored link. */
export interface DriverTelegramLinkStoredReadPortV1 {
    findStoredTelegramIds(telegramIds: readonly bigint[]): Promise<readonly string[]>
    findStoredDriverIds(driverIds: readonly string[]): Promise<readonly string[]>
}

/**
 * DISPLAY-ONLY status of the stored driver/Telegram bot link (see the
 * contract). Every distinct queried id gets exactly one entry: a malformed id,
 * or a kind whose read failed, is 'unknown'; nothing is guessed.
 */
export function createGetDriverTelegramLinkStoredStatusesHandlerV1(port: DriverTelegramLinkStoredReadPortV1) {
    return async function getDriverTelegramLinkStoredStatusesV1(
        query: BotLinkStatusQueryV1 | unknown,
    ): Promise<BotLinkStatusResultV1> {
        const parsed = parseBotLinkStatusQueryV1(query)
        const answer = async (
            ids: readonly string[] | undefined,
            queryable: (id: string) => boolean,
            find: (valid: readonly string[]) => Promise<readonly string[]>,
        ): Promise<Record<string, DriverTelegramLinkStoredStatusV1>> => {
            const distinct = [...new Set(ids ?? [])]
            const valid = distinct.filter(queryable)
            let stored: Set<string> | null = new Set()
            if (valid.length > 0) {
                try {
                    stored = new Set((await find(valid)).map(String))
                } catch {
                    stored = null
                }
            }
            return Object.fromEntries(distinct.map((id) => [
                id,
                !queryable(id) || stored === null ? 'unknown' : stored.has(id) ? 'link_stored' : 'no_link_stored',
            ]))
        }
        const [byTelegramId, byDriverId] = await Promise.all([
            answer(parsed.telegramIds, isQueryableTelegramUserIdV1, (valid) => port.findStoredTelegramIds(valid.map((id) => BigInt(id)))),
            answer(parsed.driverIds, isQueryableDriverIdV1, (valid) => port.findStoredDriverIds(valid)),
        ])
        return { byTelegramId, byDriverId }
    }
}

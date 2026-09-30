import {
    READ_DRIVER_TELEGRAM_PARK_LINKS_RESULT_V1,
    parseReadDriverTelegramParkLinksQueryV1,
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

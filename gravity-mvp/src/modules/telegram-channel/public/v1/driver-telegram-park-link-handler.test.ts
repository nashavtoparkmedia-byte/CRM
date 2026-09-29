/**
 * The one read Telegram channel publishes about a driver's bot link.
 *
 * What matters is as much what it refuses to say as what it says: a consumer
 * asking about a driver must not be able to obtain the Telegram identity, and
 * must not be able to ask for the whole table. Both are asserted here against
 * a port that deliberately offers more than the contract allows through.
 */

import { describe, expect, it, vi } from 'vitest'

import {
    DriverTelegramParkLinkQueryValidationError,
    READ_DRIVER_TELEGRAM_PARK_LINKS_MAX_DRIVER_IDS_V1,
    READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1,
    READ_DRIVER_TELEGRAM_PARK_LINKS_RESULT_V1,
} from '../../../../contracts/telegram-channel/v1'
import {
    createReadDriverTelegramParkLinksHandlerV1,
    type DriverTelegramParkLinkReadPortV1,
} from './driver-telegram-park-link-handler'

const query = (driverIds: readonly string[]) => ({
    contract: READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1,
    driverIds,
})

function port(
    rows: Array<Record<string, unknown>> = [{ driverId: 'driver-1', activeParkId: 'ext-park-1' }],
): DriverTelegramParkLinkReadPortV1 {
    return { findParkLinks: async () => rows as never }
}

describe('read driver Telegram park links', () => {
    it('returns the driver and the active park, and nothing else', async () => {
        const read = createReadDriverTelegramParkLinksHandlerV1(port([{
            driverId: 'driver-1',
            activeParkId: 'ext-park-1',
            // Everything below exists on the row and must not cross the boundary.
            telegramId: 123456789n,
            username: 'someone',
            phoneVerified: true,
            botState: 'IDLE',
            submittedPhone: '+70000000000',
            carLabel: 'A123BC',
        }]))
        const result = await read(query(['driver-1']))
        expect(result.contract).toBe(READ_DRIVER_TELEGRAM_PARK_LINKS_RESULT_V1)
        expect(result.links).toEqual([{ driverId: 'driver-1', activeParkId: 'ext-park-1' }])
        expect(Object.keys(result.links[0]).sort()).toEqual(['activeParkId', 'driverId'])
        expect(JSON.stringify(result)).not.toMatch(/123456789|someone|IDLE|70000000000|A123BC|phoneVerified/)
    })

    it('reports a link with no park chosen as a null park, not as an absent link', async () => {
        const read = createReadDriverTelegramParkLinksHandlerV1(port([
            { driverId: 'driver-1', activeParkId: null },
        ]))
        expect((await read(query(['driver-1']))).links).toEqual([{ driverId: 'driver-1', activeParkId: null }])
    })

    it('omits a driver with no link rather than describing one', async () => {
        const read = createReadDriverTelegramParkLinksHandlerV1(port([]))
        expect((await read(query(['driver-1', 'driver-2']))).links).toEqual([])
    })

    it('asks the port for each driver once', async () => {
        const findParkLinks = vi.fn(async () => [])
        const read = createReadDriverTelegramParkLinksHandlerV1({ findParkLinks })
        await read(query(['driver-1', 'driver-1', 'driver-2']))
        expect(findParkLinks).toHaveBeenCalledWith(['driver-1', 'driver-2'])
    })

    it('refuses an unbounded or empty request', async () => {
        const read = createReadDriverTelegramParkLinksHandlerV1(port())
        const tooMany = Array.from(
            { length: READ_DRIVER_TELEGRAM_PARK_LINKS_MAX_DRIVER_IDS_V1 + 1 },
            (_, index) => `driver-${index}`,
        )
        await expect(read(query(tooMany))).rejects.toThrow(DriverTelegramParkLinkQueryValidationError)
        await expect(read(query([]))).rejects.toThrow(/driverIds must not be empty/)
        await expect(read(query(['']))).rejects.toThrow(/driverIds entries are required/)
        // Exactly at the cap is allowed.
        await expect(read(query(tooMany.slice(0, -1)))).resolves.toBeDefined()
    })

    it('refuses an unversioned, wrong or widened envelope', async () => {
        const read = createReadDriverTelegramParkLinksHandlerV1(port())
        await expect(read({ driverIds: ['driver-1'] })).rejects.toThrow(/contract must equal/)
        await expect(read({ ...query(['driver-1']), telegramId: 1n })).rejects.toThrow(/unsupported field/)
        await expect(read('driver-1')).rejects.toThrow(/query must be an object/)
        await expect(read({
            contract: 'telegram_channel.ReadDriverTelegramParkLinksQuery.v2',
            driverIds: ['driver-1'],
        })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTRACT_VERSION' })
    })
})

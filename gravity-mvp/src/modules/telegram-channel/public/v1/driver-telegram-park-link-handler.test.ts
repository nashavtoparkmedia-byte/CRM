/**
 * The one read Telegram channel publishes about a driver's bot link.
 *
 * What matters is as much what it refuses to say as what it says: a consumer
 * asking about a driver must not be able to obtain the Telegram identity, and
 * must not be able to ask for the whole table. Both are asserted here against
 * a port that deliberately offers more than the contract allows through.
 */

import { describe, expect, it, vi } from 'vitest'

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
    BOT_LINK_STATUS_MAX_IDS_V1,
    BOT_LINK_STATUS_QUERY_V1,
    DriverTelegramParkLinkQueryValidationError,
    READ_DRIVER_TELEGRAM_PARK_LINKS_MAX_DRIVER_IDS_V1,
    READ_DRIVER_TELEGRAM_PARK_LINKS_QUERY_V1,
    READ_DRIVER_TELEGRAM_PARK_LINKS_RESULT_V1,
} from '../../../../contracts/telegram-channel/v1'
import {
    createGetDriverTelegramLinkStoredStatusesHandlerV1,
    createReadDriverTelegramParkLinksHandlerV1,
    type DriverTelegramLinkStoredReadPortV1,
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

describe('telegram.BotLinkStatusQuery.v1 (display-only stored-link status)', () => {
    const statusQuery = (fields: Record<string, unknown>) => ({ contract: BOT_LINK_STATUS_QUERY_V1, ...fields })
    function linkPort(telegram: string[] = ['111'], drivers: string[] = ['driver-1']): DriverTelegramLinkStoredReadPortV1 & { calls: unknown[] } {
        const calls: unknown[] = []
        return {
            calls,
            async findStoredTelegramIds(ids) { calls.push(['telegram', ids]); return telegram.filter(id => ids.some(v => v.toString() === id)) },
            async findStoredDriverIds(ids) { calls.push(['driver', ids]); return drivers.filter(id => ids.includes(id)) },
        }
    }

    it('answers link_stored / no_link_stored / unknown per distinct queried id, status only', async () => {
        const port = linkPort()
        const get = createGetDriverTelegramLinkStoredStatusesHandlerV1(port)
        const result = await get(statusQuery({
            telegramIds: ['111', '222', '111', '0', '12a', ''],
            driverIds: ['driver-1', 'driver-2', ' padded'],
        }))
        expect(result).toEqual({
            byTelegramId: { '111': 'link_stored', '222': 'no_link_stored', '0': 'unknown', '12a': 'unknown', '': 'unknown' },
            byDriverId: { 'driver-1': 'link_stored', 'driver-2': 'no_link_stored', ' padded': 'unknown' },
        })
        expect(Object.keys(result).sort()).toEqual(['byDriverId', 'byTelegramId'])
        // Only well-formed, de-duplicated ids reach the store.
        expect(port.calls).toEqual([['telegram', [111n, 222n]], ['driver', ['driver-1', 'driver-2']]])
    })

    it('a failed read answers unknown for that kind only, never a guess', async () => {
        const get = createGetDriverTelegramLinkStoredStatusesHandlerV1({
            async findStoredTelegramIds() { throw new Error('db down') },
            async findStoredDriverIds() { return ['driver-1'] },
        })
        await expect(get(statusQuery({ telegramIds: ['111'], driverIds: ['driver-1'] }))).resolves.toEqual({
            byTelegramId: { '111': 'unknown' },
            byDriverId: { 'driver-1': 'link_stored' },
        })
    })

    it('touches no store for an empty query and refuses an unbounded or foreign one', async () => {
        const port = linkPort()
        const get = createGetDriverTelegramLinkStoredStatusesHandlerV1(port)
        await expect(get(statusQuery({}))).resolves.toEqual({ byTelegramId: {}, byDriverId: {} })
        expect(port.calls).toEqual([])
        const tooMany = Array.from({ length: BOT_LINK_STATUS_MAX_IDS_V1 + 1 }, (_, i) => String(i + 1))
        await expect(get(statusQuery({ telegramIds: tooMany }))).rejects.toBeInstanceOf(DriverTelegramParkLinkQueryValidationError)
        await expect(get(statusQuery({ driverIds: tooMany }))).rejects.toBeInstanceOf(DriverTelegramParkLinkQueryValidationError)
        await expect(get({ contract: 'telegram.BotLinkStatusQuery.v2', telegramIds: ['1'] })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTRACT_VERSION' })
        await expect(get(statusQuery({ telegramIds: ['1'], includeNames: true }))).rejects.toMatchObject({ code: 'INVALID_CONTRACT' })
        await expect(get(statusQuery({ telegramIds: [1] }))).rejects.toMatchObject({ code: 'INVALID_CONTRACT' })
        expect(port.calls).toEqual([])
    })

    it('is display-only: no access, Cash or fleet-operations code may consume it', () => {
        const root = join(__dirname, '../../../..')
        const files: string[] = []
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const path = join(dir, name)
                if (statSync(path).isDirectory()) walk(path)
                else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path)
            }
        }
        for (const dir of ['modules/fleet-operations', 'modules/identity-access', 'app/compensation']) walk(join(root, dir))
        const consumers = files.filter(file => /getDriverTelegramLinkStoredStatusesV1|BotLinkStatusQuery/.test(readFileSync(file, 'utf8')))
        expect(consumers).toEqual([])
        const contract = readFileSync(join(root, 'contracts/telegram-channel/v1/driver-telegram-park-link-queries.ts'), 'utf8')
        expect(contract).toMatch(/DISPLAY-ONLY[\s\S]*grants[\s*]+nothing[\s*]+and[\s*]+must[\s*]+not[\s*]+be[\s*]+used[\s*]+for[\s*]+any[\s*]+access[\s*]+decision/)
    })
})


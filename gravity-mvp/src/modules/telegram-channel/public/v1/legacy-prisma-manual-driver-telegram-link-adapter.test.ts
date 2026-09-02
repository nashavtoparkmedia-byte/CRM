import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    authorize: vi.fn(),
    reauthorize: vi.fn(),
    transaction: vi.fn(),
    queryRaw: vi.fn(),
    txFindUnique: vi.fn(),
    create: vi.fn(),
    findUnique: vi.fn(),
    deleteMany: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        $transaction: mocks.transaction,
        driverTelegram: {
            findUnique: mocks.findUnique,
            deleteMany: mocks.deleteMany,
        },
    },
}))
vi.mock('./manual-driver-telegram-link-authority', () => ({
    prepareManualDriverTelegramLinkAuthorityV1: mocks.authorize,
    revalidatePreparedManualDriverTelegramLinkAuthorityV1: mocks.reauthorize,
}))

import {
    ManualDriverTelegramLinkContradictionError,
    legacyPrismaManualDriverTelegramLinkPortV1 as port,
} from './legacy-prisma-manual-driver-telegram-link-adapter'

const preparedAuthority = {
    chatId: 'chat-42',
    contactId: 'contact-1',
    contactIdentityId: 'identity-42',
    providerAccountId: 'telegram-account-1',
    connectionId: 'telegram-connection-1',
    target: '42',
    identityTarget: '42',
}

describe('legacy Prisma manual DriverTelegram authority boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.authorize.mockResolvedValue(preparedAuthority)
        mocks.reauthorize.mockResolvedValue(undefined)
        mocks.queryRaw.mockResolvedValue([{ admitted: true }])
        mocks.transaction.mockImplementation(async work => work({
            $queryRaw: mocks.queryRaw,
            driverTelegram: {
                findUnique: mocks.txFindUnique,
                create: mocks.create,
            },
        }))
        mocks.txFindUnique.mockResolvedValue(null)
        mocks.create.mockResolvedValue({ id: 'mapping-1' })
        mocks.findUnique.mockResolvedValue({ driverId: 'driver-1', telegramId: 42n })
        mocks.deleteMany.mockResolvedValue({ count: 1 })
    })

    test('performs zero mutation when exact Chat/Contact authority is absent', async () => {
        mocks.authorize.mockRejectedValue(
            new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED'),
        )

        await expect(port.save({ driverId: 'driver-1', telegramId: 42n }))
            .rejects.toThrow('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED')
        expect(mocks.transaction).not.toHaveBeenCalled()
        expect(mocks.create).not.toHaveBeenCalled()
    })

    test('creates an exact new mapping without manufacturing phone verification', async () => {
        await port.save({ driverId: 'driver-1', telegramId: 42n })

        expect(mocks.authorize).toHaveBeenCalledWith({ driverId: 'driver-1', telegramId: 42n })
        expect(mocks.reauthorize).toHaveBeenCalledWith(
            expect.objectContaining({ $queryRaw: mocks.queryRaw }),
            { driverId: 'driver-1', telegramId: 42n },
            preparedAuthority,
        )
        expect(mocks.queryRaw).toHaveBeenCalledTimes(4)
        expect(mocks.queryRaw.mock.invocationCallOrder[3])
            .toBeLessThan(mocks.reauthorize.mock.invocationCallOrder[0])
        expect(mocks.reauthorize.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.create.mock.invocationCallOrder[0])
        expect(mocks.create).toHaveBeenCalledWith({
            data: { driverId: 'driver-1', telegramId: 42n },
        })
        expect(mocks.create.mock.calls[0][0].data).not.toHaveProperty('phoneVerified')
    })

    test('rolls back before mapping write when authority changes while waiting for CNT1', async () => {
        mocks.reauthorize.mockRejectedValue(
            new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED'),
        )

        await expect(port.save({ driverId: 'driver-1', telegramId: 42n }))
            .rejects.toThrow('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED')

        expect(mocks.authorize).toHaveBeenCalledOnce()
        expect(mocks.queryRaw).toHaveBeenCalledTimes(4)
        expect(mocks.reauthorize).toHaveBeenCalledOnce()
        expect(mocks.create).not.toHaveBeenCalled()
        expect(mocks.queryRaw.mock.invocationCallOrder[3])
            .toBeLessThan(mocks.reauthorize.mock.invocationCallOrder[0])
    })

    test('is idempotent for the exact same mapping', async () => {
        mocks.txFindUnique.mockResolvedValue({ driverId: 'driver-1', telegramId: 42n })

        await port.save({ driverId: 'driver-1', telegramId: 42n })

        expect(mocks.create).not.toHaveBeenCalled()
    })

    test('never overwrites a contradictory Driver or Telegram mapping', async () => {
        mocks.txFindUnique
            .mockResolvedValueOnce({ driverId: 'driver-1', telegramId: 99n })
            .mockResolvedValueOnce({ driverId: 'driver-2', telegramId: 42n })

        await expect(port.save({ driverId: 'driver-1', telegramId: 42n }))
            .rejects.toBeInstanceOf(ManualDriverTelegramLinkContradictionError)
        expect(mocks.create).not.toHaveBeenCalled()
    })

    test('performs zero delete when the existing peer no longer has authority', async () => {
        mocks.authorize.mockRejectedValue(
            new Error('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED'),
        )

        await expect(port.remove('driver-1'))
            .rejects.toThrow('DRIVER_TELEGRAM_EXACT_PRIVATE_CHAT_REQUIRED')
        expect(mocks.deleteMany).not.toHaveBeenCalled()
    })

    test('deletes only the mapping whose exact Driver and peer were authorized', async () => {
        await port.remove('driver-1')

        expect(mocks.authorize).toHaveBeenCalledWith({ driverId: 'driver-1', telegramId: 42n })
        expect(mocks.deleteMany).toHaveBeenCalledWith({
            where: { driverId: 'driver-1', telegramId: 42n },
        })
    })
})

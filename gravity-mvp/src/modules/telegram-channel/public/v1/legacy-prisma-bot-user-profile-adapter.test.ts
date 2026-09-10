import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    upsert: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        botUserRegistry: { upsert: mocks.upsert },
    },
}))

import { legacyPrismaBotUserProfilePortV1 } from './legacy-prisma-bot-user-profile-adapter'

describe('legacy Prisma bot-user profile phone trust', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.upsert.mockResolvedValue({})
    })

    test('updates a replacement phone and its verification state atomically', async () => {
        const verifiedAt = new Date('2026-09-02T12:00:00.000Z')
        const replacedAt = new Date('2026-09-02T12:05:00.000Z')

        await legacyPrismaBotUserProfilePortV1.record({
            telegramId: 123n,
            username: null,
            firstName: null,
            lastName: null,
            phone: '+79990001122',
            phoneVerified: true,
            observedAt: verifiedAt,
        })

        await legacyPrismaBotUserProfilePortV1.record({
            telegramId: 123n,
            username: null,
            firstName: null,
            lastName: null,
            phone: '+79990002233',
            phoneVerified: false,
            observedAt: replacedAt,
        })

        expect(mocks.upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
            update: expect.objectContaining({
                phone: '+79990001122',
                phoneVerified: true,
                profileCheckedAt: verifiedAt,
            }),
        }))
        expect(mocks.upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
            where: { telegramId: 123n },
            update: expect.objectContaining({
                phone: '+79990002233',
                phoneVerified: false,
                profileCheckedAt: replacedAt,
                lastSeenAt: replacedAt,
            }),
        }))
    })

    test('a profile-only observation preserves the existing phone/trust pair', async () => {
        const observedAt = new Date('2026-09-02T12:05:00.000Z')

        await legacyPrismaBotUserProfilePortV1.record({
            telegramId: 123n,
            username: 'driver',
            firstName: null,
            lastName: null,
            phone: null,
            phoneVerified: false,
            observedAt,
        })

        expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
            update: expect.objectContaining({
                phone: undefined,
                phoneVerified: undefined,
                profileCheckedAt: observedAt,
                lastSeenAt: observedAt,
            }),
            create: expect.objectContaining({
                phone: null,
                phoneVerified: false,
            }),
        }))
    })
})

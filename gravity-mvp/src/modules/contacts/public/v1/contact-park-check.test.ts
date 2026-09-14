import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    runOwnership: vi.fn(),
    lock: vi.fn(),
    assertPostconditions: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: { contact: { findFirst: vi.fn() } } }))
vi.mock('../../internal/contact-ownership-coordinator', () => ({
    runContactOwnershipTransaction: mocks.runOwnership,
    lockContactOwnershipRows: mocks.lock,
    assertContactOwnershipPostconditions: mocks.assertPostconditions,
}))

import { persistContactParkCheckResultV1 } from './contact-park-check'

const transaction = {
    contact: {
        findUnique: mocks.findUnique,
        update: mocks.update,
    },
}

describe('Contact park-check persistence', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.runOwnership.mockImplementation(async (work: (value: typeof transaction) => Promise<unknown>) => work(transaction))
        mocks.lock.mockResolvedValue({
            contactIds: ['contact-1'],
            phoneIds: [],
            normalizedPhones: [],
            identityIds: [],
            mergeIds: [],
        })
        mocks.update.mockResolvedValue({ id: 'contact-1' })
    })

    test('serializes the read-modify-write under the Contact ownership lock', async () => {
        mocks.findUnique.mockResolvedValue({ customFields: { retained: true }, isArchived: false })
        const snapshot = { checkStatus: 'complete' as const, checkedAt: '2026-09-02T00:00:00.000Z' }

        await expect(persistContactParkCheckResultV1('contact-1', snapshot)).resolves.toBe(true)

        expect(mocks.runOwnership).toHaveBeenCalledOnce()
        expect(mocks.lock).toHaveBeenCalledWith(transaction, { contactIds: ['contact-1'] })
        expect(mocks.update).toHaveBeenCalledWith({
            where: { id: 'contact-1' },
            data: {
                customFields: {
                    retained: true,
                    parkCheckResult: snapshot,
                    parkCheckLastAttempt: snapshot,
                },
            },
        })
        expect(mocks.assertPostconditions).toHaveBeenCalledWith(transaction, expect.objectContaining({
            contactIds: ['contact-1'],
        }))
        expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(mocks.findUnique.mock.invocationCallOrder[0])
        expect(mocks.findUnique.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0])
        expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(mocks.assertPostconditions.mock.invocationCallOrder[0])
    })

    test.each(['partial', 'failed'] as const)(
        'records a %s attempt separately without replacing the last complete result',
        async checkStatus => {
            const lastComplete = { checkStatus: 'complete', checkedAt: '2026-09-01T00:00:00.000Z' }
            const attempt = { checkStatus, checkedAt: '2026-09-02T00:00:00.000Z' }
            mocks.findUnique.mockResolvedValue({
                customFields: { retained: 'value', parkCheckResult: lastComplete },
                isArchived: false,
            })

            await expect(persistContactParkCheckResultV1('contact-1', attempt)).resolves.toBe(true)

            expect(mocks.update).toHaveBeenCalledWith({
                where: { id: 'contact-1' },
                data: {
                    customFields: {
                        retained: 'value',
                        parkCheckResult: lastComplete,
                        parkCheckLastAttempt: attempt,
                    },
                },
            })
        },
    )

    test.each([
        ['missing', null],
        ['archived', { customFields: { retained: true }, isArchived: true }],
    ])('does not mutate a %s Contact after acquiring the lock', async (_state, contact) => {
        mocks.findUnique.mockResolvedValue(contact)

        await expect(persistContactParkCheckResultV1('contact-1', {
            checkStatus: 'failed',
        })).resolves.toBe(false)

        expect(mocks.lock).toHaveBeenCalledOnce()
        expect(mocks.update).not.toHaveBeenCalled()
        expect(mocks.assertPostconditions).not.toHaveBeenCalled()
    })
})

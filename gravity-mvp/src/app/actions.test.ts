import { beforeEach, describe, expect, test, vi } from 'vitest'

const { prismaMock } = vi.hoisted(() => ({
    prismaMock: {
        apiConnection: { findMany: vi.fn() },
    },
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/contracts/fleet-operations/v1', () => ({}))
vi.mock('@/modules/fleet-operations/public/v1', () => ({}))
vi.mock('@/modules/identity-access/public/v1', () => ({ requireIntegrationAdminAccess: vi.fn() }))

import { getApiConnections } from '@/modules/fleet-operations/public/v1/yandex-fleet-operations'

beforeEach(() => vi.resetAllMocks())

describe('getApiConnections public projection', () => {
    test('does not select or return apiKey', async () => {
        const metadata = {
            id: 'connection-1',
            clid: 'taxi/park/1',
            parkId: 'park-1',
            name: 'Primary park',
            createdAt: new Date('2026-08-11T00:00:00.000Z'),
        }
        prismaMock.apiConnection.findMany.mockResolvedValueOnce([metadata])

        const connections = await getApiConnections()

        expect(prismaMock.apiConnection.findMany).toHaveBeenCalledWith({
            orderBy: { createdAt: 'desc' },
            select: { id: true, clid: true, parkId: true, name: true, createdAt: true },
        })
        expect(connections[0]).not.toHaveProperty('apiKey')
        expect(connections[0]).toMatchObject(metadata)
    })
})

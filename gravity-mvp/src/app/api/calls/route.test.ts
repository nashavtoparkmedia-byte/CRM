import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    findMany: vi.fn(),
    resolveContactLineage: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        call: {
            findMany: mocks.findMany,
        },
    },
}))

vi.mock('@/modules/contacts/public/v1', () => ({
    resolveContactLineageV1: mocks.resolveContactLineage,
}))

import { GET } from './route'

describe('GET /api/calls merged Contact and simulation filters', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.findMany.mockResolvedValue([])
    })

    it('keeps simulated calls excluded while reading the complete Contact merge lineage', async () => {
        mocks.resolveContactLineage.mockResolvedValue({
            canonicalContactId: 'contact-survivor',
            contactIds: ['contact-survivor', 'contact-loser'],
        })

        const response = await GET(new NextRequest(
            'https://crm.example/api/calls?contactId=contact-loser&limit=25',
        ))

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ calls: [] })
        expect(mocks.resolveContactLineage).toHaveBeenCalledWith('contact-loser')
        expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                isSimulation: false,
                contactId: { in: ['contact-survivor', 'contact-loser'] },
            },
            orderBy: { startedAt: 'desc' },
            take: 25,
        }))
    })

    it('returns an empty history without querying Calls when the Contact lineage is absent', async () => {
        mocks.resolveContactLineage.mockResolvedValue(null)

        const response = await GET(new NextRequest(
            'https://crm.example/api/calls?contactId=missing-contact',
        ))

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ calls: [] })
        expect(mocks.findMany).not.toHaveBeenCalled()
    })
})

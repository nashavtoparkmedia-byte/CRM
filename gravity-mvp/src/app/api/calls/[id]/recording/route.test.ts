import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    findFirst: vi.fn(),
    getObject: vi.fn(),
}))

vi.mock('@/modules/identity-access/public/v1/user-directory', () => ({
    getCurrentUserIdentityV1: mocks.getCurrentUser,
}))
vi.mock('@/lib/prisma', () => ({
    prisma: { call: { findFirst: mocks.findFirst } },
}))
vi.mock('@/modules/calling/public/v1/recording-storage', () => ({
    getObject: mocks.getObject,
}))

import { GET } from './route'

const context = { params: Promise.resolve({ id: 'call-1' }) }

function request(range?: string) {
    return new NextRequest('https://crm.example/api/calls/call-1/recording', {
        headers: range ? { range } : undefined,
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentUser.mockResolvedValue(null)
})

describe('call recording streaming route', () => {
    it('rejects anonymous access before reading Call state or recording storage', async () => {
        const response = await GET(request(), context)

        expect(response.status).toBe(401)
        expect(mocks.findFirst).not.toHaveBeenCalled()
        expect(mocks.getObject).not.toHaveBeenCalled()
    })

    it('excludes simulated Calls from the recording lookup', async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' })
        mocks.findFirst.mockResolvedValue(null)

        const response = await GET(request(), context)

        expect(response.status).toBe(404)
        expect(mocks.findFirst).toHaveBeenCalledWith({
            where: { id: 'call-1', isSimulation: false },
            select: { recordingPath: true },
        })
        expect(mocks.getObject).not.toHaveBeenCalled()
    })

    it('returns the complete recording with the existing private streaming headers', async () => {
        const recording = Buffer.from([0, 1, 2, 255])
        mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' })
        mocks.findFirst.mockResolvedValue({ recordingPath: 'recordings/call-1.mp3' })
        mocks.getObject.mockResolvedValue(recording)

        const response = await GET(request(), context)

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('audio/mpeg')
        expect(response.headers.get('content-length')).toBe('4')
        expect(response.headers.get('accept-ranges')).toBe('bytes')
        expect(response.headers.get('cache-control')).toBe('private, max-age=3600')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(recording))
        expect(mocks.getObject).toHaveBeenCalledWith('recordings/call-1.mp3')
    })

    it('preserves byte Range response status, body, and seek headers', async () => {
        mocks.getCurrentUser.mockResolvedValue({ id: 'user-1' })
        mocks.findFirst.mockResolvedValue({ recordingPath: 'recordings/call-1.mp3' })
        mocks.getObject.mockResolvedValue(Buffer.from([10, 20, 30, 40]))

        const response = await GET(request('bytes=1-2'), context)

        expect(response.status).toBe(206)
        expect(response.headers.get('content-type')).toBe('audio/mpeg')
        expect(response.headers.get('content-range')).toBe('bytes 1-2/4')
        expect(response.headers.get('content-length')).toBe('2')
        expect(response.headers.get('accept-ranges')).toBe('bytes')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([20, 30]))
    })
})

import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUserIdentityV1 as getCurrentUser } from '@/modules/identity-access/public/v1/user-directory'
import { prisma } from '@/lib/prisma'
import { getObject } from '@/modules/calling/public/v1/recording-storage'

/**
 * GET /api/calls/[id]/recording
 *
 * Streams the MP3 recording through the Next.js server.
 * Streaming avoids the mixed-content problem that arises when MinIO is
 * accessed via an internal Docker hostname (http://minio:9000) while the
 * CRM runs on HTTPS — browsers block http:// resources on https:// pages.
 *
 * Supports partial content (Range) so the browser audio player can seek.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    const { id } = await params
    const call = await prisma.call.findFirst({
        where: { id, isSimulation: false },
        select: { recordingPath: true },
    })
    if (!call) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (!call.recordingPath) return NextResponse.json({ error: 'no_recording' }, { status: 404 })

    try {
        const buffer = await getObject(call.recordingPath)
        const total = buffer.byteLength

        const rangeHeader = req.headers.get('range')
        if (rangeHeader) {
            // Partial content — browser is seeking
            const [, rangeSpec] = rangeHeader.split('=')
            const [startStr, endStr] = rangeSpec.split('-')
            const start = parseInt(startStr, 10)
            const end = endStr ? parseInt(endStr, 10) : total - 1
            const chunkSize = end - start + 1
            return new NextResponse(buffer.slice(start, end + 1), {
                status: 206,
                headers: {
                    'Content-Type': 'audio/mpeg',
                    'Content-Range': `bytes ${start}-${end}/${total}`,
                    'Content-Length': String(chunkSize),
                    'Accept-Ranges': 'bytes',
                },
            })
        }

        return new NextResponse(buffer, {
            status: 200,
            headers: {
                'Content-Type': 'audio/mpeg',
                'Content-Length': String(total),
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'private, max-age=3600',
            },
        })
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

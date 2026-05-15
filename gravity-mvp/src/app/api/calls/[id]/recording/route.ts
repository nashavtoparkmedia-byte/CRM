import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/users/user-service'
import { prisma } from '@/lib/prisma'
import { getRecordingUrl } from '@/lib/storage/minio'

/**
 * GET /api/calls/[id]/recording
 *
 * Returns a short-lived presigned URL for the call's MP3 recording.
 * Open to any authenticated CRM user (Stage 3 ACL choice — see project_telephony.md).
 *
 * The presigned URL points directly at MinIO/Yandex S3 — the browser
 * streams the file without going through the Next.js server. Lifetime
 * defaults to 1 hour, so a copied URL stops working after one work session.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

    const { id } = await params
    const call = await prisma.call.findUnique({
        where: { id },
        select: { recordingPath: true },
    })
    if (!call) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    if (!call.recordingPath) return NextResponse.json({ error: 'no_recording' }, { status: 404 })

    try {
        const url = await getRecordingUrl(call.recordingPath)
        return NextResponse.json({ url })
    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 })
    }
}

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getObject } from '@/lib/storage/minio'

export async function GET(_request: Request, { params }: { params: Promise<{ actionId: string; index: string }> }) {
    const { actionId, index } = await params
    const action = await prisma.driverAction.findUnique({ where: { id: actionId }, select: { result: true } })
    const result = action?.result && typeof action.result === 'object' ? action.result as Record<string, any> : null
    const diagnostic = result?.diagnostics?.[Number(index)]
    if (!diagnostic) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    try {
        const body = diagnostic.objectKey
            ? await getObject(diagnostic.objectKey)
            : Buffer.from(diagnostic.imageBase64 || '', 'base64')
        if (!body.length) throw new Error('empty diagnostic')
        return new NextResponse(body, { headers: { 'Content-Type': diagnostic.contentType || 'image/jpeg', 'Cache-Control': 'private, max-age=300' } })
    } catch {
        return NextResponse.json({ error: 'Artifact unavailable' }, { status: 404 })
    }
}

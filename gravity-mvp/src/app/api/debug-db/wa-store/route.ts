import { NextRequest, NextResponse } from 'next/server'
import { inspectOperationalWhatsAppStoreV1 } from '@/infrastructure/whatsapp/operational-capabilities'

export async function GET(req: NextRequest) {
    const connId = req.nextUrl.searchParams.get('connId')
    const chatId = req.nextUrl.searchParams.get('chatId') || undefined
    const limit = parseInt(req.nextUrl.searchParams.get('limit') || '10')

    if (!connId) return NextResponse.json({ error: 'connId required' })

    try {
        const result = await inspectOperationalWhatsAppStoreV1(connId, chatId, limit)
        return NextResponse.json(result)
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

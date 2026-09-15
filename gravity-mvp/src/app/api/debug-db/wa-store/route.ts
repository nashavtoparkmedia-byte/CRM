import { NextRequest, NextResponse } from 'next/server'
import { inspectOperationalWhatsAppStoreV1 } from '@/infrastructure/whatsapp/operational-capabilities'
import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'

export async function GET(req: NextRequest) {
    // Debug surface: same signed integration-admin session that guards the
    // WhatsApp/Telegram connection admin actions this endpoint can drive.
    if (!await getIntegrationAdminPrincipal()) {
        return NextResponse.json({ success: false, error: 'DEBUG_ENDPOINT_FORBIDDEN' }, { status: 403 })
    }
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

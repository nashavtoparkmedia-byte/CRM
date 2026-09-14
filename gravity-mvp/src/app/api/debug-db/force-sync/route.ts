import { NextRequest, NextResponse } from 'next/server'
import { forceSyncOperationalWhatsAppV1 } from '@/infrastructure/whatsapp/operational-capabilities'
import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'

export async function GET(req: NextRequest) {
    // Debug surface: same signed integration-admin session that guards the
    // WhatsApp/Telegram connection admin actions this endpoint can drive.
    if (!await getIntegrationAdminPrincipal()) {
        return NextResponse.json({ success: false, error: 'DEBUG_ENDPOINT_FORBIDDEN' }, { status: 403 })
    }
    const connectionId = req.nextUrl.searchParams.get('id')
    if (!connectionId) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 })

    try {
        console.log(`[FORCE-SYNC-API] Syncing history for ${connectionId}`)
        await forceSyncOperationalWhatsAppV1(connectionId)
        return NextResponse.json({ success: true, message: 'Sync started/completed' })
    } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 })
    }
}

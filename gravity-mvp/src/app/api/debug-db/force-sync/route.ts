import { NextRequest, NextResponse } from 'next/server'
import { forceSync } from '@/lib/whatsapp/WhatsAppService'

export async function GET(req: NextRequest) {
    const connectionId = req.nextUrl.searchParams.get('id')
    if (!connectionId) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 })

    try {
        console.log(`[FORCE-SYNC-API] Syncing history for ${connectionId}`)
        await forceSync(connectionId)
        return NextResponse.json({ success: true, message: 'Sync started/completed' })
    } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 })
    }
}

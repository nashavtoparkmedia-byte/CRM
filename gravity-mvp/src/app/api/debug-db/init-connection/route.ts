import { NextRequest, NextResponse } from 'next/server'
import { initializeClient } from '@/lib/whatsapp/WhatsAppService'

export async function GET(req: NextRequest) {
    const connectionId = req.nextUrl.searchParams.get('id')
    if (!connectionId) return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 })

    try {
        console.log(`[INIT-WA-API] Initializing connection: ${connectionId}`)
        await initializeClient(connectionId)
        return NextResponse.json({ success: true, message: 'Initialization started' })
    } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 })
    }
}

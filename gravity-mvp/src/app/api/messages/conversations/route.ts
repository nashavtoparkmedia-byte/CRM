import { NextResponse } from 'next/server'
import { MessageService } from '@/lib/MessageService'

// Lazy init: ensure Telegram listeners are running on first API call
let _tgInitDone = false
async function ensureTelegramListeners() {
    if (_tgInitDone) return
    _tgInitDone = true
    try {
        const { initTelegramListeners } = await import('@/app/tg-actions')
        await initTelegramListeners()
        console.log('[API-CONVERSATIONS] Telegram listeners initialized (lazy)')
    } catch (err: any) {
        console.error('[API-CONVERSATIONS] Failed to init TG listeners:', err.message)
        _tgInitDone = false // Allow retry on next call
    }
}

export async function GET() {
    try {
        // Fire-and-forget TG init (don't block the response)
        ensureTelegramListeners().catch(() => {})
        
        const conversations = await MessageService.listConversations()
        return NextResponse.json(conversations)
    } catch (error: any) {
        console.error('[API-CONVERSATIONS] GET Error:', error)
        return NextResponse.json({ 
            error: 'Internal Server Error', 
            details: error.message,
            stack: error.stack 
        }, { status: 500 })
    }
}

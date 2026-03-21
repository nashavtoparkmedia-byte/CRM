import { NextRequest, NextResponse } from 'next/server'
import { MessageService } from '@/lib/MessageService'

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url)
        const chatId = searchParams.get('chatId')

        if (!chatId) {
            return NextResponse.json({ error: 'chatId is required' }, { status: 400 })
        }

        const limit = parseInt(searchParams.get('limit') || '50')
        const chatIds = chatId.includes(',') ? chatId.split(',') : chatId
        const messages = await MessageService.listMessages(chatIds, limit)
        
        return NextResponse.json(messages)
    } catch (error) {
        console.error('[API-MESSAGES] GET Error:', error)
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        const { chatId, content, profileId, channel } = body

        if (!chatId || !content) {
            return NextResponse.json({ error: 'chatId and content are required' }, { status: 400 })
        }

        const result = await MessageService.send(chatId, content, channel, profileId)
        return NextResponse.json(result)
    } catch (error: any) {
        console.error('[API-MESSAGES] POST Error:', error)
        return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 })
    }
}

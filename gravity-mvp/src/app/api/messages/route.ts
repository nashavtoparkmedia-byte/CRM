import { NextRequest, NextResponse } from 'next/server'
import { MessageService } from '@/lib/MessageService'
import { contactPermissionRefusalV1 } from '@/modules/messaging/public/v1/delivery-state-policy'

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
        const { chatId, content, profileId, channel, clientMessageId, quotedMsgId } = body

        if (!chatId || !content) {
            return NextResponse.json({ error: 'chatId and content are required' }, { status: 400 })
        }

        const result = await MessageService.send(chatId, content, channel, profileId, clientMessageId, quotedMsgId)
        return NextResponse.json(result)
    } catch (error: any) {
        console.error('[API-MESSAGES] POST Error:', error)
        const refusal = contactPermissionRefusalV1(error)
        if (refusal) return NextResponse.json({ error: refusal.label, code: refusal.code }, { status: refusal.retryable ? 503 : 403 })
        if (error?.message === 'MESSAGING_SEND_TO_CONTACT_NAMESPACE_RESERVED') {
            return NextResponse.json({ error: 'Недопустимый идентификатор сообщения', code: 'CLIENT_MESSAGE_ID_RESERVED' }, { status: 400 })
        }
        return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 })
    }
}

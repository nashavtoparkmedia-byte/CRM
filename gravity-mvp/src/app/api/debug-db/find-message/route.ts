import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'

export async function GET(req: NextRequest) {
    // Debug surface: same signed integration-admin session that guards the
    // WhatsApp/Telegram connection admin actions this endpoint can drive.
    if (!await getIntegrationAdminPrincipal()) {
        return NextResponse.json({ success: false, error: 'DEBUG_ENDPOINT_FORBIDDEN' }, { status: 403 })
    }
    const query = req.nextUrl.searchParams.get('q') || '203'
    try {
        console.log(`[DEBUG-DB] Searching for messages containing: "${query}"`)
        const messages = await prisma.message.findMany({
            where: { content: { contains: query } },
            include: { chat: true },
            orderBy: { createdAt: 'desc' }
        })

        return NextResponse.json({ 
            success: true, 
            count: messages.length,
            messages: messages.map(m => ({
                id: m.id,
                content: m.content,
                direction: m.direction,
                chatId: m.chatId,
                externalChatId: m.chat.externalChatId,
                createdAt: m.createdAt
            }))
        })
    } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 })
    }
}

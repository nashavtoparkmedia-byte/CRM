import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'

export async function GET() {
    // Debug surface: same signed integration-admin session that guards the
    // WhatsApp/Telegram connection admin actions this endpoint can drive.
    if (!await getIntegrationAdminPrincipal()) {
        return NextResponse.json({ success: false, error: 'DEBUG_ENDPOINT_FORBIDDEN' }, { status: 403 })
    }
    const wa = await prisma.whatsAppConnection.findMany({
        select: { id: true, name: true, phoneNumber: true, status: true }
    })
    const recentChats = await prisma.chat.findMany({
        take: 15,
        orderBy: { lastMessageAt: 'desc' },
        select: { id: true, channel: true, externalChatId: true, name: true, driverId: true, lastMessageAt: true }
    })
    const recentMessages = await prisma.message.findMany({
        take: 20,
        orderBy: { sentAt: 'desc' },
        select: { id: true, chatId: true, content: true, direction: true, channel: true, status: true, sentAt: true }
    })
    return NextResponse.json({ wa, recentChats, recentMessages })
}

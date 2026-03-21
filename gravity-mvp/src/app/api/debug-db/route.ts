import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
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

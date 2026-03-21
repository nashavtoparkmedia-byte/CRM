import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
    try {
        const chats = await (prisma.chat as any).findMany({
            include: { driver: true },
            orderBy: { createdAt: 'desc' }
        })
        return NextResponse.json({ 
            success: true, 
            count: chats.length,
            chats: chats.map(c => ({
                id: c.id,
                name: c.name,
                channel: c.channel,
                externalChatId: c.externalChatId,
                driverId: c.driverId,
                driverName: c.driver?.fullName,
                createdAt: c.createdAt
            }))
        })
    } catch (err: any) {
        return NextResponse.json({ success: false, error: err.message }, { status: 500 })
    }
}

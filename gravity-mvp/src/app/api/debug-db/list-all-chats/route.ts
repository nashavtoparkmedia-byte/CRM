import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'

export async function GET(req: NextRequest) {
    // Debug surface: same signed integration-admin session that guards the
    // WhatsApp/Telegram connection admin actions this endpoint can drive.
    if (!await getIntegrationAdminPrincipal()) {
        return NextResponse.json({ success: false, error: 'DEBUG_ENDPOINT_FORBIDDEN' }, { status: 403 })
    }
    try {
        const chats = await (prisma.chat as any).findMany({
            include: { driver: true },
            orderBy: { createdAt: 'desc' }
        })
        return NextResponse.json({ 
            success: true, 
            count: chats.length,
            chats: chats.map((c: any) => ({
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

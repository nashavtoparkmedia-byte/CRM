import { NextRequest, NextResponse } from 'next/server'
import { getClient, getRuntimeStatus } from '@/lib/whatsapp/WhatsAppService'
import { prisma } from '@/lib/prisma'

// Diagnostic endpoint — reports WhatsApp connection state. Baileys edition.
// Query: ?connId=<id> for detail, no query for list.
export async function GET(req: NextRequest) {
    const connId = req.nextUrl.searchParams.get('connId')
    if (!connId) {
        const conns = await prisma.whatsAppConnection.findMany()
        const result = conns.map(c => ({
            id: c.id,
            status: c.status,
            phone: c.phoneNumber,
            hasClient: !!getClient(c.id),
        }))
        return NextResponse.json({
            runtime: getRuntimeStatus(),
            connections: result,
        })
    }

    const sock = getClient(connId)
    if (!sock) {
        return NextResponse.json({ error: 'Client not in memory', connId })
    }

    try {
        const rosterEntries = await prisma.whatsAppChatRoster.findMany({
            where: { connectionId: connId },
            orderBy: { lastSeen: 'desc' },
            take: 20,
        })
        const legacyChats = await prisma.whatsAppChat.count({ where: { connectionId: connId } })
        const legacyMsgs = await prisma.whatsAppMessage.count({ where: { chat: { connectionId: connId } } })

        // Helper: oldest/newest message timestamps in legacy table for this connection.
        // Useful for cutoff verification without scanning /api/messages per chat.
        const [oldestMsg, newestMsg] = await Promise.all([
            prisma.whatsAppMessage.findFirst({
                where: { chat: { connectionId: connId } },
                orderBy: { timestamp: 'asc' },
                select: { timestamp: true },
            }),
            prisma.whatsAppMessage.findFirst({
                where: { chat: { connectionId: connId } },
                orderBy: { timestamp: 'desc' },
                select: { timestamp: true },
            }),
        ])

        return NextResponse.json({
            connId,
            wsUser: sock.user?.id ?? null,
            legacyChats,
            legacyMsgs,
            oldestLegacyMsgTs: oldestMsg?.timestamp ?? null,
            newestLegacyMsgTs: newestMsg?.timestamp ?? null,
            rosterSize: await prisma.whatsAppChatRoster.count({ where: { connectionId: connId } }),
            rosterSample: rosterEntries.map(r => ({
                jid: r.jid,
                name: r.name,
                oldestMsgTs: r.oldestMsgTs,
                lastSeen: r.lastSeen,
                hasAnchorKey: !!r.oldestMsgKey,
            })),
        })
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}

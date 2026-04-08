import { NextRequest, NextResponse } from 'next/server'
import { getClient } from '@/lib/whatsapp/WhatsAppService'
import { prisma } from '@/lib/prisma'

export async function GET(req: NextRequest) {
    const connId = req.nextUrl.searchParams.get('connId')
    if (!connId) {
        // List all connections and client status
        const conns = await prisma.whatsAppConnection.findMany()
        const result = conns.map(c => ({
            id: c.id,
            status: c.status,
            phone: c.phoneNumber,
            hasClient: !!getClient(c.id),
        }))
        return NextResponse.json({ connections: result })
    }

    const client = getClient(connId)
    if (!client) {
        return NextResponse.json({ error: 'Client not in memory', connId })
    }

    try {
        const chats = await client.getChats()
        const results: any[] = []

        // Test fetchMessages on first 5 chats that are not groups
        let tested = 0
        for (const chat of chats) {
            if (tested >= 5) break
            if (chat.isGroup) continue
            tested++

            try {
                const msgs = await chat.fetchMessages({ limit: 10 })
                results.push({
                    chatId: chat.id._serialized,
                    name: chat.name,
                    fetchedCount: msgs.length,
                    sampleTimestamps: msgs.slice(0, 3).map(m => ({
                        ts: new Date(m.timestamp * 1000).toISOString(),
                        body: (m.body || '').substring(0, 30),
                        fromMe: m.fromMe,
                        id: m.id._serialized,
                    })),
                })
            } catch (e: any) {
                results.push({
                    chatId: chat.id._serialized,
                    name: chat.name,
                    error: e.message,
                })
            }
        }

        return NextResponse.json({
            connId,
            totalChats: chats.length,
            nonGroupChats: chats.filter(c => !c.isGroup).length,
            tested: results,
        })
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}

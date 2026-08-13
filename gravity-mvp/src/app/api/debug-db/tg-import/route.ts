import { NextResponse } from 'next/server'
import { importOperationalTelegramHistoryV1 } from '@/infrastructure/telegram/operational-capabilities'
import { prisma } from '@/lib/prisma'

export async function POST(req: Request) {
    try {
        const { connectionId, daysBack = 30 } = await req.json()

        const conn = await prisma.telegramConnection.findUnique({
            where: { id: connectionId },
            select: { id: true },
        })
        if (!conn) return NextResponse.json({ error: 'Connection not found' }, { status: 404 })

        // Fire-and-forget — import runs in background
        importOperationalTelegramHistoryV1('debug-import', 'last_n_days', daysBack, connectionId)
            .catch(e => console.error('[DEBUG-TG-IMPORT] error:', e.message))

        return NextResponse.json({ ok: true, connectionId, daysBack, message: 'Import started in background' })
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 })
    }
}

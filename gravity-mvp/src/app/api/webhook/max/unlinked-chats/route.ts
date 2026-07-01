/**
 * PR-П: Endpoint для max-web-scraper — отдаёт список MAX placeholder-чатов
 * которым нужно name из MAX UI.
 *
 * Scraper делает GET → получает массив chatId → навигирует в каждый chat в
 * браузере → читает header text → отдаёт обратно через POST sync-names.
 *
 * Использует ту же isPlaceholderName что в webhook/max/route.ts.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

function isPlaceholderName(name?: string | null): boolean {
    if (!name) return true
    const t = name.trim()
    if (!t) return true
    if (/^(TG|MAX|WA|Telegram|Max|WhatsApp)[\s:]+\d+$/i.test(t)) return true
    if (/^\d+$/.test(t)) return true
    if (/^[.\s\-]+$/.test(t)) return true
    return false
}

export async function GET(_req: NextRequest) {
    try {
        // Только MAX-чаты с placeholder name (или null), у которых
        // externalChatId — pure numeric (т.е. MAX internal chatId).
        const chats = await prisma.chat.findMany({
            where: { channel: 'max' },
            select: { externalChatId: true, name: true },
        })

        const unlinkedIds = chats
            .filter(c => isPlaceholderName(c.name))
            .map(c => c.externalChatId)
            .filter(eid => /^\d+$/.test(eid ?? ''))

        return NextResponse.json({
            chatIds: unlinkedIds,
            total: unlinkedIds.length,
        })
    } catch (error: any) {
        console.error('[MAX-UNLINKED] error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}

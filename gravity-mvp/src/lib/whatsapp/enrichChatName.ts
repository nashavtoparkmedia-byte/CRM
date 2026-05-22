/**
 * PR-Л: Helper для автоматического подтягивания chat.name из sibling-чатов.
 *
 * Контекст: WhatsApp Business может породить НЕСКОЛЬКО Chat-записей для
 * одного контакта через разные @lid идентификаторы (смена JID, переход
 * на Business и т.п.). У одного chat есть name = "+7 982 707-22-57"
 * (из pushname), а другой chat того же contactId создаётся с name=NULL.
 *
 * Этот helper вызывается ПОСЛЕ upsert chat. Если у chat name placeholder/NULL
 * и есть contactId — ищет sibling chat того же contactId с осмысленным
 * name → копирует. Идемпотентно: ничего не делает если name уже хороший.
 *
 * Используется в WhatsAppService.syncHistory и WhatsAppService.importHistory.
 */
import { prisma } from '@/lib/prisma'

function isPlaceholder(name: string | null | undefined): boolean {
    if (!name) return true
    const t = String(name).trim()
    if (!t) return true
    if (/^[.\s\-]+$/.test(t)) return true
    if (/^(TG|MAX|WA|Telegram|Max|WhatsApp)\s+\d+$/i.test(t)) return true
    // голые цифры < 10 — internal ID
    if (/^\d+$/.test(t) && t.length < 10) return true
    return false
}

/**
 * Enrich WA-chat name из sibling-чата того же contactId.
 * @returns обновлённое имя или null если ничего не изменилось.
 */
export async function enrichWaChatNameFromSibling(
    chatId: string,
    currentName: string | null | undefined,
    contactId: string | null | undefined,
    driverId: string | null | undefined = null,
): Promise<string | null> {
    // Уже хорошее имя — ничего не делаем
    if (!isPlaceholder(currentName)) return null
    // Нет на что опереться
    if (!contactId && !driverId) return null

    const orFilters: any[] = []
    if (contactId) orFilters.push({ contactId })
    if (driverId) orFilters.push({ driverId })

    const siblings = await prisma.chat.findMany({
        where: {
            AND: [
                { id: { not: chatId } },
                { channel: 'whatsapp' },
                { name: { not: null } },
                { OR: orFilters },
            ],
        },
        select: { id: true, name: true, driverId: true },
        orderBy: { lastMessageAt: 'desc' },
        take: 5,
    })

    const goodSibling = siblings.find(s => !isPlaceholder(s.name))
    if (!goodSibling) return null

    const updates: any = { name: goodSibling.name }
    if (!driverId && goodSibling.driverId) {
        updates.driverId = goodSibling.driverId
    }

    await prisma.chat.update({ where: { id: chatId }, data: updates })
    console.log(`[wa-enrich] chat=${chatId} name "${currentName ?? 'null'}" → "${goodSibling.name}" (donor ${goodSibling.id})`)
    return goodSibling.name as string
}

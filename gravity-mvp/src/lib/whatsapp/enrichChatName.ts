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
import { PATCH_CHANNEL_CONVERSATION_COMMAND_V1 } from '@/contracts/messaging/v1'
import { patchChannelConversationV1 } from '@/modules/messaging/public/v1'
import { attachPhoneToIdentityV1 } from '@/modules/contacts/public/v1'
import { normalizePhoneE164 } from '@/modules/contacts/public/v1/phone-identity'

/** Accept only chat titles composed entirely of phone punctuation and 10/11 digits. */
export function phoneFromWaChatName(name: string | null | undefined): string | null {
    const value = String(name || '').trim()
    if (!value || !/^\+?[\d\s()\-]+$/.test(value)) return null
    const digitCount = value.replace(/\D/g, '').length
    if (digitCount !== 10 && digitCount !== 11) return null
    return normalizePhoneE164(value)
}

/** Backfill the visible WA number onto an already-linked opaque @lid identity. */
export async function attachVisibleWaPhone(chatId: string): Promise<boolean> {
    const chat = await prisma.chat.findUnique({
        where: { id: chatId },
        select: { name: true, contactId: true, contactIdentityId: true },
    })
    if (!chat?.contactId || !chat.contactIdentityId) return false

    const phone = phoneFromWaChatName(chat.name)
    if (!phone) return false

    const result = await attachPhoneToIdentityV1(
        chat.contactId,
        chat.contactIdentityId,
        phone,
        { source: 'whatsapp', confirmed: true },
    )
    if (result.kind === 'conflict') {
        console.warn(
            `[wa-enrich] visible phone conflict chat=${chatId} phone=${phone} `
            + `contact=${chat.contactId} owner=${result.otherContactId}`,
        )
        return false
    }
    return true
}

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

    await patchChannelConversationV1({
        contract: PATCH_CHANNEL_CONVERSATION_COMMAND_V1,
        selector: { chatId },
        patch: { name: goodSibling.name, ...(!driverId && goodSibling.driverId ? { driverId: goodSibling.driverId } : {}) },
    })
    console.log(`[wa-enrich] chat=${chatId} name "${currentName ?? 'null'}" → "${goodSibling.name}" (donor ${goodSibling.id})`)
    return goodSibling.name as string
}

"use server"

import { prisma } from "@/lib/prisma"
import { revalidatePath } from "next/cache"
import { SET_CONTACT_DISPLAY_NAME_COMMAND_V1 } from "@/contracts/contacts/v1"
import { resolveChannelContactOperationV1, setContactDisplayNameV1 } from "@/modules/contacts/public/v1"
import { ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1 } from "@/contracts/messaging/v1"
import { ensureConversationContactLinkV1 } from "@/modules/messaging/public/v1"

/**
 * PR-О: Server actions для UI «Привязать контакт» в чатах.
 *
 * Используется когда chat создан с placeholder name и нет linked Driver/Contact
 * (типично для WA @lid дубликатов, MAX outbound-only, TG с first_name "."
 * без username).
 */

export type DriverSearchResult = {
    id: string
    fullName: string
    phone: string | null
}

/**
 * Поиск водителя по части имени или телефона.
 * Возвращает топ-20 результатов отсортированных по релевантности.
 */
export async function searchDriversForLinking(query: string): Promise<DriverSearchResult[]> {
    const q = query.trim()
    if (q.length < 2) return []

    const digits = q.replace(/\D/g, '')
    const orFilters: any[] = [
        { fullName: { contains: q, mode: 'insensitive' } },
    ]
    if (digits.length >= 4) {
        orFilters.push({ phone: { contains: digits } })
    }

    const drivers = await prisma.driver.findMany({
        where: { OR: orFilters },
        select: { id: true, fullName: true, phone: true },
        orderBy: { fullName: 'asc' },
        take: 20,
    })
    return drivers
}

/**
 * Привязать chat к указанному Driver. Обновляет:
 *   — chat.driverId, chat.name (driver.fullName)
 *   — Contact.displayName (если placeholder)
 *   — Создаёт ContactIdentity если нужно (через публичную Contacts capability)
 */
export async function linkChatToDriverManually(chatId: string, driverId: string): Promise<{ success: true } | { error: string }> {
    try {
        const chat = await prisma.chat.findUnique({
            where: { id: chatId },
            select: { id: true, channel: true, externalChatId: true, contactId: true, name: true },
        })
        if (!chat) return { error: 'Чат не найден' }

        const driver = await prisma.driver.findUnique({
            where: { id: driverId },
            select: { id: true, fullName: true, phone: true },
        })
        if (!driver) return { error: 'Водитель не найден' }

        // 1. Обновим Chat
        await prisma.chat.update({
            where: { id: chatId },
            data: { driverId: driver.id, name: driver.fullName },
        })

        // 2. Если у Driver есть phone и channel поддерживает phone-identity —
        //    создаём/обновляем Contact через ContactService.
        const phoneDigits = (driver.phone ?? '').replace(/\D/g, '')
        if (phoneDigits.length >= 10 && (chat.channel === 'whatsapp' || chat.channel === 'max' || chat.channel === 'phone')) {
            try {
                const contactResult = await resolveChannelContactOperationV1(
                    chat.channel as any,
                    phoneDigits,
                    phoneDigits,
                    driver.fullName,
                )
                await ensureConversationContactLinkV1({
                    contract: ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1,
                    chatId: chat.id,
                    contactId: contactResult.contact.id,
                    contactIdentityId: contactResult.identity.id,
                })
            } catch (err: any) {
                console.warn(`[linkChatToDriverManually] ContactService failed (non-blocking): ${err.message}`)
            }
        } else if (chat.contactId) {
            await setContactDisplayNameV1({
                contract: SET_CONTACT_DISPLAY_NAME_COMMAND_V1,
                contactId: chat.contactId,
                displayName: driver.fullName,
            })
        }

        revalidatePath('/messages')
        return { success: true }
    } catch (e: any) {
        console.error('[linkChatToDriverManually] error:', e)
        return { error: e.message || 'Не удалось привязать' }
    }
}

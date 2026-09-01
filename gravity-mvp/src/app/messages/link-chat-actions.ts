"use server"

import type { Prisma } from "@prisma/client"

import { prisma } from "@/lib/prisma"
import { revalidatePath } from "next/cache"
import { SET_CONTACT_DISPLAY_NAME_COMMAND_V1 } from "@/contracts/contacts/v1"
import { setContactDisplayNameV1 } from "@/modules/contacts/public/v1"
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
    const orFilters: Prisma.DriverWhereInput[] = [
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
 *
 * Provider identity is authoritative. This action may annotate an already
 * linked identity, but it must never derive a Telegram/MAX/WhatsApp identity
 * from the selected driver's mutable phone number.
 */
export async function linkChatToDriverManually(chatId: string, driverId: string): Promise<{ success: true } | { error: string }> {
    try {
        const chat = await prisma.chat.findUnique({
            where: { id: chatId },
            select: {
                id: true,
                contactId: true,
                contactIdentityId: true,
                metadata: true,
                contactIdentity: { select: { contactId: true, isActive: true } },
            },
        })
        if (!chat) return { error: 'Чат не найден' }

        if (
            !chat.contactId
            || !chat.contactIdentityId
            || !chat.contactIdentity?.isActive
            || chat.contactIdentity.contactId !== chat.contactId
        ) {
            return {
                error: 'Стабильный идентификатор канала не сохранён. Свяжите идентификатор с контактом вручную.',
            }
        }

        const driver = await prisma.driver.findUnique({
            where: { id: driverId },
            select: { id: true, fullName: true, phone: true },
        })
        if (!driver) return { error: 'Водитель не найден' }

        const contactResult = {
            contact: { id: chat.contactId },
            identity: { id: chat.contactIdentityId },
        }
        await ensureConversationContactLinkV1({
            contract: ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1,
            chatId: chat.id,
            contactId: contactResult.contact.id,
            contactIdentityId: contactResult.identity.id,
        })

        const metadata = chat.metadata && typeof chat.metadata === 'object' && !Array.isArray(chat.metadata)
            ? chat.metadata as Record<string, unknown>
            : {}

        // The existing opaque identity remains attached to its current Contact.
        await prisma.chat.update({
            where: { id: chatId },
            data: {
                driverId: driver.id,
                name: driver.fullName,
                metadata: {
                    ...metadata,
                    contactResolution: {
                        status: 'manual_driver_linked',
                        candidateCount: 1,
                        automaticLinkPerformed: false,
                        contactIdentityId: chat.contactIdentityId,
                    },
                },
            },
        })

        await setContactDisplayNameV1({
            contract: SET_CONTACT_DISPLAY_NAME_COMMAND_V1,
            contactId: chat.contactId,
            displayName: driver.fullName,
        })

        revalidatePath('/messages')
        return { success: true }
    } catch (e: unknown) {
        console.error('[linkChatToDriverManually] error:', e)
        return { error: e instanceof Error ? e.message : 'Не удалось привязать' }
    }
}

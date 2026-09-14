"use server"

import type { Prisma } from "@prisma/client"

import { prisma } from "@/lib/prisma"
import { revalidatePath } from "next/cache"
import { ENSURE_CONVERSATION_CONTACT_LINK_COMMAND_V1 } from "@/contracts/messaging/v1"
import {
    ensureConversationContactLinkV1,
    linkMatchedDriverToConversationCapabilityV1,
} from "@/modules/messaging/public/v1"

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
                contact: {
                    select: {
                        id: true,
                        isArchived: true,
                        mainDriverId: true,
                        customFields: true,
                    },
                },
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
            select: { id: true },
        })
        if (!driver) return { error: 'Водитель не найден' }

        const contactFields = chat.contact?.customFields
            && typeof chat.contact.customFields === 'object'
            && !Array.isArray(chat.contact.customFields)
            ? chat.contact.customFields as Record<string, unknown>
            : {}
        const driverConfirmations = Array.isArray(contactFields.driverConfirmations)
            ? contactFields.driverConfirmations
            : []
        const hasExactConfirmation = driverConfirmations.some(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return false
            const confirmation = item as Record<string, unknown>
            return confirmation.status === 'confirmed'
                && confirmation.representativeDriverId === driver.id
        })
        if (
            !chat.contact
            || chat.contact.isArchived
            || chat.contact.mainDriverId !== driver.id
            || !hasExactConfirmation
        ) {
            return {
                error: 'Сначала подтвердите физлицо водителя через «Это он» и завершите сверку противоречий.',
            }
        }

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

        const linked = await linkMatchedDriverToConversationCapabilityV1({
            chatId: chat.id,
            driverId: driver.id,
        })
        if (!linked.linked) {
            return { error: 'Чат уже привязан к другому профилю водителя; требуется сверка.' }
        }

        revalidatePath('/messages')
        return { success: true }
    } catch (e: unknown) {
        console.error('[linkChatToDriverManually] error:', e)
        return { error: e instanceof Error ? e.message : 'Не удалось привязать' }
    }
}

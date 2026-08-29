import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

export type ContactParkCheckContextV1 = {
    activePhones: string[]
    yandexDriverId: string | null
}

export async function getContactParkCheckContextV1(contactId: string): Promise<ContactParkCheckContextV1 | null> {
    const contact = await prisma.contact.findFirst({
        where: { id: contactId, isArchived: false },
        select: {
            phones: {
                where: { isActive: true },
                orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
                select: { phone: true },
            },
            yandexDriverId: true,
        },
    })
    return contact ? {
        activePhones: contact.phones.map(item => item.phone),
        yandexDriverId: contact.yandexDriverId,
    } : null
}

/** Exact Contacts-owned write: retain only the latest park-check snapshot. */
export async function persistContactParkCheckResultV1(
    contactId: string,
    parkCheckResult: Record<string, unknown>,
): Promise<boolean> {
    const contact = await prisma.contact.findFirst({
        where: { id: contactId, isArchived: false },
        select: { customFields: true },
    })
    if (!contact) return false
    const current = contact.customFields && typeof contact.customFields === 'object' && !Array.isArray(contact.customFields)
        ? contact.customFields as Record<string, unknown>
        : {}
    const customFields = JSON.parse(JSON.stringify({ ...current, parkCheckResult })) as Prisma.InputJsonValue
    await prisma.contact.update({ where: { id: contactId }, data: { customFields } })
    return true
}

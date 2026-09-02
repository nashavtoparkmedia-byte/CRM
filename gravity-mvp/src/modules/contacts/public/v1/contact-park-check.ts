import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
    assertContactOwnershipPostconditions,
    lockContactOwnershipRows,
    runContactOwnershipTransaction,
} from '../../internal/contact-ownership-coordinator'

export type ContactParkCheckContextV1 = {
    activePhones: string[]
    yandexDriverId: string | null
}

export type ContactParkCheckStatusV1 = 'complete' | 'partial' | 'failed'

export type ContactParkCheckSnapshotV1 = Record<string, unknown> & {
    checkStatus: ContactParkCheckStatusV1
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

/**
 * Contacts-owned park-check evidence write.
 *
 * A failed or partial attempt must not replace the last complete snapshot:
 * Fleet absence is authoritative only when every configured park answered.
 */
export async function persistContactParkCheckResultV1(
    contactId: string,
    parkCheckResult: ContactParkCheckSnapshotV1,
): Promise<boolean> {
    return runContactOwnershipTransaction(async transaction => {
        const scope = await lockContactOwnershipRows(transaction, { contactIds: [contactId] })
        const contact = await transaction.contact.findUnique({
            where: { id: contactId },
            select: { customFields: true, isArchived: true },
        })
        if (!contact || contact.isArchived) return false

        const current = contact.customFields && typeof contact.customFields === 'object' && !Array.isArray(contact.customFields)
            ? contact.customFields as Record<string, unknown>
            : {}
        const next = parkCheckResult.checkStatus === 'complete'
            ? { ...current, parkCheckResult, parkCheckLastAttempt: parkCheckResult }
            : { ...current, parkCheckLastAttempt: parkCheckResult }
        const customFields = JSON.parse(JSON.stringify(next)) as Prisma.InputJsonValue
        await transaction.contact.update({ where: { id: contactId }, data: { customFields } })
        await assertContactOwnershipPostconditions(transaction, scope)
        return true
    })
}

import { prisma } from '@/lib/prisma'
import { ContactService } from '@/lib/ContactService'
import { normalizePhoneE164 } from '@/lib/phoneUtils'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createAiCallContactResolver } = require('./contact-resolution-core')

export type AiCallContactResolution =
    | {
        status: 'resolved'
        source: 'explicit_contact' | 'existing_phone' | 'canonical_created' | 'canonical_existing'
        contactId: string
        driverId: string | null
        phoneE164: string
        displayName: string | null
        created: boolean
    }
    | {
        status: 'invalid_input' | 'not_found' | 'conflict'
        reason: string
        phoneE164?: string
    }
    | {
        status: 'ambiguous'
        reason: 'multiple_contacts_for_phone'
        phoneE164: string
        candidateContactIds: string[]
    }

export interface AiCallContactInput {
    contactId?: string | null
    driverId?: string | null
    phoneNumber?: string | null
}

const resolveCore = createAiCallContactResolver({
    normalizePhone: normalizePhoneE164,
    findContactById: (id: string) => prisma.contact.findUnique({
        where: { id },
        select: {
            id: true,
            displayName: true,
            phones: {
                where: {
                    isActive: true,
                    OR: [
                        { isTemporary: false },
                        { isTemporary: true, expiresAt: null },
                        { isTemporary: true, expiresAt: { gt: new Date() } },
                    ],
                },
                orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
                select: { phone: true, isPrimary: true },
            },
        },
    }),
    findDriverById: (id: string) => prisma.driver.findUnique({
        where: { id },
        select: { id: true, phone: true, fullName: true },
    }),
    findContactsByPhone: (phone: string) => prisma.contactPhone.findMany({
        where: {
            phone,
            isActive: true,
            OR: [
                { isTemporary: false },
                { isTemporary: true, expiresAt: null },
                { isTemporary: true, expiresAt: { gt: new Date() } },
            ],
        },
        select: {
            contactId: true,
            contact: { select: { displayName: true } },
        },
        take: 3,
    }).then(rows => rows.map(row => ({
        contactId: row.contactId,
        displayName: row.contact.displayName,
    }))),
    resolveByPhone: (phone: string, displayName: string | null) =>
        ContactService.resolveByPhone(phone, displayName),
})

export async function resolveAiCallContact(
    input: AiCallContactInput,
): Promise<AiCallContactResolution> {
    return resolveCore(input)
}

export function contactResolutionHttpStatus(result: AiCallContactResolution): number {
    if (result.status === 'ambiguous' || result.status === 'conflict') return 409
    if (result.status === 'not_found') return 404
    if (result.status === 'invalid_input') return 400
    return 200
}

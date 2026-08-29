import { prisma } from '@/lib/prisma'
import type { MarkTemporaryContactPhonePersistencePortV1 } from './mark-temporary-contact-phone-handler'
export const legacyPrismaMarkTemporaryContactPhonePortV1: MarkTemporaryContactPhonePersistencePortV1 = { async mark(input) { const result = await prisma.contactPhone.updateMany({ where: { contactId: input.contactId, phone: input.phone, isTemporary: false }, data: { isTemporary: true, expiresAt: input.expiresAt, label: input.label } }); return result.count } }

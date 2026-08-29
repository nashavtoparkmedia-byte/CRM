import { prisma } from '@/lib/prisma'
import type { FleetContactPersistencePortV1 } from './fleet-contact-handler'

export const legacyPrismaFleetContactPortV1: FleetContactPersistencePortV1 = {
    async patch(contactId, patch) {
        await prisma.contact.update({ where: { id: contactId }, data: patch })
    },
    async create(input) {
        return prisma.contact.create({ data: input, select: { id: true, primaryPhoneId: true } })
    },
}

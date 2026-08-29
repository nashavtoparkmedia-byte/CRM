import { prisma } from '@/lib/prisma'
import type { SetContactDisplayNamePersistencePortV1 } from './set-contact-display-name-handler'

export const legacyPrismaSetContactDisplayNamePortV1: SetContactDisplayNamePersistencePortV1 = {
    async setDisplayName({ contactId, displayName }) {
        const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { id: true } })
        if (!contact) return 'not_found'
        await prisma.contact.update({ where: { id: contact.id }, data: { displayName } })
        return 'updated'
    },
}

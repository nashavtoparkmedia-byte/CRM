import { prisma } from '@/lib/prisma'
import type { ResolveContactPersistencePortV2 } from './resolve-contact-handler'

export const legacyPrismaResolveContactPortV2: ResolveContactPersistencePortV2 = {
    async promoteChannelDisplayName({ contactId, candidateDisplayName }) {
        const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { id: true, displayNameSource: true } })
        if (!contact) return 'not_found'
        if (contact.displayNameSource !== 'channel') return 'preserved'
        await prisma.contact.update({ where: { id: contact.id }, data: { displayName: candidateDisplayName } })
        return 'updated'
    },
}

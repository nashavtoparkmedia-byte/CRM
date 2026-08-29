import { prisma } from '@/lib/prisma'
import type { ResolveContactPersistencePortV1 } from './resolve-contact-handler'
import { isLegacyPlaceholderContactNameV1 } from './legacy-contact-name-policy'

export const legacyPrismaResolveContactPortV1: ResolveContactPersistencePortV1 = {
    async promotePlaceholderDisplayName({ contactId, candidateDisplayName }) {
        const contact = await prisma.contact.findUnique({
            where: { id: contactId },
            select: { id: true, displayName: true },
        })
        if (!contact) return 'not_found'
        if (!isLegacyPlaceholderContactNameV1(contact.displayName)) return 'preserved'

        await prisma.contact.update({
            where: { id: contact.id },
            data: { displayName: candidateDisplayName },
        })
        return 'updated'
    },
}

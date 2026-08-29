import { prisma } from '@/lib/prisma'
import type { AttachContactIdentityPersistencePortV1 } from './attach-contact-identity-handler'

export const legacyPrismaAttachContactIdentityPortV1: AttachContactIdentityPersistencePortV1 = {
    async replaceProfile({ identityId, handle, givenName, familyName }) {
        await prisma.contactIdentity.update({
            where: { id: identityId },
            data: {
                metadata: {
                    username: handle,
                    firstName: givenName,
                    lastName: familyName,
                },
            },
        })
    },
}

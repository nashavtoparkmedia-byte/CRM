import { prisma } from '@/lib/prisma'
import type { ContactRetentionPersistencePortV1 } from './contact-retention-handler'

export const legacyPrismaContactRetentionPortV1: ContactRetentionPersistencePortV1 = {
  async deleteContactForRetention(contactId) {
    const result = await prisma.contact.deleteMany({ where: { id: contactId } })
    return result.count > 0 ? 'deleted' : 'missing'
  },
}

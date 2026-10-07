import type { Prisma } from '@prisma/client'

import type { ContactLineagePersistencePortV1 } from '../public/v1/contact-lineage-handler'
import { contactAutomationState } from '../public/v1/contact-evidence-state'

export type ContactLineageClientV1 = Pick<Prisma.TransactionClient, 'contact' | 'contactMerge'>

/**
 * The Contact lineage port bound to a caller-supplied client, so an owner
 * mutation holding the Contacts ownership lock, or a read inside one snapshot
 * transaction, resolves the same lineage through the same handler
 * (createResolveContactLineageHandlerV1) on the client it holds. It reads
 * exactly what the public legacyPrismaContactLineagePortV1 reads; it is a
 * binding of the existing resolver, never a second one.
 */
export function makePrismaContactLineagePortV1(client: ContactLineageClientV1): ContactLineagePersistencePortV1 {
  return {
    async findRedirect(contactId) {
      const contact = await client.contact.findUnique({
        where: { id: contactId },
        select: { id: true, customFields: true },
      })
      return contact
        ? { id: contact.id, mergedIntoContactId: contactAutomationState(contact.customFields).mergedIntoContactId }
        : null
    },
    async findMergedContactIds(survivorId) {
      const merges = await client.contactMerge.findMany({
        where: { survivorId, action: 'merge' },
        select: { mergedId: true },
        orderBy: { id: 'asc' },
      })
      return merges.map(merge => merge.mergedId)
    },
  }
}

import { prisma } from '@/lib/prisma'

import type { ContactLineagePersistencePortV1 } from './contact-lineage-handler'
import { contactAutomationState } from './contact-evidence-state'

export const legacyPrismaContactLineagePortV1: ContactLineagePersistencePortV1 = {
  async findRedirect(contactId) {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: { id: true, customFields: true },
    })
    return contact
      ? { id: contact.id, mergedIntoContactId: contactAutomationState(contact.customFields).mergedIntoContactId }
      : null
  },
  async findMergedContactIds(survivorId) {
    const merges = await prisma.contactMerge.findMany({
      where: { survivorId, action: 'merge' },
      select: { mergedId: true },
      orderBy: { id: 'asc' },
    })
    return merges.map(merge => merge.mergedId)
  },
}

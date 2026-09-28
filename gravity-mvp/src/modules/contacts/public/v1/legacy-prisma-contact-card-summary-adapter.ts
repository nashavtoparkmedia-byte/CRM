// The only database reader behind ContactCardSummary.v1.
//
// It touches Contacts-owned models only — Contact, ContactPhone,
// ContactIdentity and ContactMerge — and never Chat, Message, Driver or any
// provider table, so the summary cannot acquire foreign-domain state through
// its persistence port. It also does not assemble anything: it returns the exact
// source shape and the pure projection does the rest.

import { prisma } from '@/lib/prisma'

import type { ContactCardSummaryPortV1, ContactCardSummarySourceV1 } from './contact-card-summary'
import { phoneEvidenceState } from './contact-evidence-state'

export const legacyPrismaContactCardSummaryPortV1: ContactCardSummaryPortV1 = {
  async findContactCardSummarySource(contactId): Promise<ContactCardSummarySourceV1 | null> {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      select: {
        id: true,
        displayName: true,
        displayNameSource: true,
        masterSource: true,
        primaryPhoneId: true,
        customFields: true,
        phones: {
          select: { id: true, phone: true, isPrimary: true, isActive: true, verifiedAt: true },
          orderBy: { createdAt: 'asc' },
        },
        identities: {
          select: { channel: true, isActive: true, metadata: true, displayName: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    })
    if (!contact) return null

    const mergedFromCount = await prisma.contactMerge.count({
      where: { survivorId: contact.id, action: 'merge' },
    })

    return {
      id: contact.id,
      displayName: contact.displayName,
      displayNameSource: String(contact.displayNameSource),
      masterSource: String(contact.masterSource),
      primaryPhoneId: contact.primaryPhoneId,
      customFields: contact.customFields,
      phones: contact.phones.map(phone => ({
        id: phone.id,
        phone: phone.phone,
        isPrimary: phone.isPrimary,
        isActive: phone.isActive,
        // Phone lifecycle is Contacts-owned evidence kept in customFields, so it
        // is read through the Contacts accessor rather than guessed here.
        lifecycle: phoneEvidenceState(contact.customFields, phone.id, {
          phone: phone.phone,
          isActive: phone.isActive,
          verifiedAt: phone.verifiedAt,
        }).lifecycle,
      })),
      identities: contact.identities.map(identity => ({
        channel: String(identity.channel),
        isActive: identity.isActive,
        metadata: identity.metadata,
        displayName: identity.displayName,
      })),
      mergedFromCount,
      // Contacts owns no source for a confirmed person name; see the contract.
      confirmedPersonName: null,
    }
  },
}

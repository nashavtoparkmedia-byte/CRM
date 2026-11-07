// The only database reader behind contacts.ContactCardForConversationQuery.v1.
//
// It reads Contacts-owned models only — Contact, ContactPhone, ContactIdentity
// and ContactMerge — by the exact Contact id it is given, inside one REPEATABLE
// READ snapshot, so the card never mixes two moments of the same Contact. It
// never reads Chat, Message, Driver or any provider table, never selects a
// provider external id, and never writes. It assembles nothing beyond the source
// shape; the pure projection does the rest.

import { Prisma } from '@prisma/client'

import { prisma } from '@/lib/prisma'

import type { ContactCardSourcePortV1, ContactCardSourceV1 } from './contact-card-for-conversation'
import { confirmedPersonNameV1, phoneEvidenceState } from '../public/v1/contact-evidence-state'

type ContactCardSourceClient = Pick<typeof prisma, '$transaction'>

export function makePrismaContactCardSourcePortV1(client: ContactCardSourceClient): ContactCardSourcePortV1 {
  return {
    findContactCardSource(contactId) {
      return client.$transaction(async (tx): Promise<ContactCardSourceV1 | null> => {
        const contact = await tx.contact.findUnique({
          where: { id: contactId },
          select: {
            id: true,
            displayName: true,
            displayNameSource: true,
            primaryPhoneId: true,
            isArchived: true,
            customFields: true,
            phones: {
              select: { id: true, phone: true, isActive: true, verifiedAt: true },
              orderBy: { createdAt: 'asc' },
            },
            identities: {
              select: { id: true, channel: true, isActive: true, metadata: true, displayName: true },
              orderBy: { createdAt: 'asc' },
            },
          },
        })
        if (contact === null) return null

        const mergedFromCount = await tx.contactMerge.count({ where: { survivorId: contact.id, action: 'merge' } })

        return {
          id: contact.id,
          displayName: contact.displayName,
          displayNameSource: String(contact.displayNameSource),
          primaryPhoneId: contact.primaryPhoneId,
          isArchived: contact.isArchived,
          customFields: contact.customFields,
          phones: contact.phones.map(phone => ({
            id: phone.id,
            phone: phone.phone,
            isActive: phone.isActive,
            // Phone lifecycle is Contacts-owned evidence kept in customFields.
            lifecycle: phoneEvidenceState(contact.customFields, phone.id, {
              phone: phone.phone,
              isActive: phone.isActive,
              verifiedAt: phone.verifiedAt,
            }).lifecycle,
          })),
          identities: contact.identities.map(identity => ({
            id: identity.id,
            channel: String(identity.channel),
            isActive: identity.isActive,
            metadata: identity.metadata,
            displayName: identity.displayName,
          })),
          mergedFromCount,
          confirmedPersonName: confirmedPersonNameV1(contact.customFields),
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
    },
  }
}

export const legacyPrismaContactCardSourcePortV1 = makePrismaContactCardSourcePortV1(prisma)

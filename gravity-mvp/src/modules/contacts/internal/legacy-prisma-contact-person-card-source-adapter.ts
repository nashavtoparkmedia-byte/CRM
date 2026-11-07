// The only database reader behind contacts.ContactPersonCardQuery.v1.
//
// It reads Contacts-owned models only — Contact, ContactPhone, ContactIdentity
// and ContactMerge — by the exact Contact id it is given, inside one REPEATABLE
// READ snapshot, and resolves the lineage with the existing lineage handler bound
// to the same client. It never reads Chat, Message, Driver or any provider table
// and never writes. It assembles nothing beyond the source shape; the pure
// projection does the rest.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { createResolveContactLineageHandlerV1 } from '../public/v1/contact-lineage-handler'
import { makePrismaContactLineagePortV1 } from './prisma-contact-lineage-port'
import type { ContactPersonCardSourcePortV1, ContactPersonCardSourceV1 } from './contact-person-card'

type ContactPersonCardSourceClient = Pick<typeof prisma, '$transaction'>

export function makePrismaContactPersonCardSourcePortV1(client: ContactPersonCardSourceClient): ContactPersonCardSourcePortV1 {
  return {
    findContactPersonCardSource(contactId) {
      return client.$transaction(async (tx): Promise<ContactPersonCardSourceV1 | null> => {
        const contact = await tx.contact.findUnique({
          where: { id: contactId },
          select: {
            id: true,
            displayName: true,
            displayNameSource: true,
            masterSource: true,
            primaryPhoneId: true,
            isArchived: true,
            customFields: true,
            mainDriverId: true,
            yandexDriverId: true,
            phones: {
              select: { id: true, phone: true, isPrimary: true, isActive: true, verifiedAt: true },
              orderBy: { createdAt: 'asc' },
            },
            identities: {
              select: {
                id: true,
                channel: true,
                externalId: true,
                displayName: true,
                isActive: true,
                source: true,
                metadata: true,
                phoneId: true,
                reachabilityStatus: true,
                reachabilityCheckedAt: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        })
        if (contact === null) return null
        const resolveLineage = createResolveContactLineageHandlerV1(makePrismaContactLineagePortV1(tx))
        const lineage = await resolveLineage(contact.id)
        const lineageIds = lineage?.contactIds ?? [contact.id]
        const merges = await tx.contactMerge.findMany({
          where: { OR: [{ survivorId: { in: lineageIds } }, { mergedId: { in: lineageIds } }] },
          select: { id: true, action: true, reason: true, mergedBy: true, createdAt: true, mergedId: true, survivorId: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: 100,
        })
        return {
          id: contact.id,
          displayName: contact.displayName,
          displayNameSource: String(contact.displayNameSource),
          masterSource: String(contact.masterSource),
          primaryPhoneId: contact.primaryPhoneId,
          isArchived: contact.isArchived,
          customFields: contact.customFields,
          mainDriverId: contact.mainDriverId,
          yandexDriverId: contact.yandexDriverId,
          phones: contact.phones,
          identities: contact.identities.map(identity => ({
            id: identity.id,
            channel: String(identity.channel),
            externalId: identity.externalId,
            displayName: identity.displayName,
            isActive: identity.isActive,
            source: String(identity.source),
            metadata: identity.metadata,
            phoneId: identity.phoneId,
            reachabilityStatus: String(identity.reachabilityStatus),
            reachabilityCheckedAt: identity.reachabilityCheckedAt,
            createdAt: identity.createdAt,
          })),
          lineage: lineage === null ? null : { canonicalContactId: lineage.canonicalContactId, contactIds: lineage.contactIds },
          merges: merges.map(merge => ({
            id: merge.id,
            action: String(merge.action),
            reason: String(merge.reason),
            mergedBy: merge.mergedBy,
            createdAt: merge.createdAt,
            mergedId: merge.mergedId,
            survivorId: merge.survivorId,
          })),
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
    },
  }
}

export const legacyPrismaContactPersonCardSourcePortV1 = makePrismaContactPersonCardSourcePortV1(prisma)

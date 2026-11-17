// The reader behind contacts.ContactIdentityMembershipQuery.v1: the asked
// Contact's lineage (the existing lineage handler), its archive flag and the
// asked accounts' owner, active flag and conflict evidence, in one REPEATABLE
// READ snapshot. Ids and flags only; it never selects a phone, an externalId
// or a name, and never writes.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { createResolveContactLineageHandlerV1 } from '../public/v1/contact-lineage-handler'
import { identityEvidenceState } from '../public/v1/contact-evidence-state'
import { makePrismaContactLineagePortV1 } from './prisma-contact-lineage-port'
import type { ContactIdentityMembershipSourcePortV1 } from './contact-identity-membership'

export function makePrismaContactIdentityMembershipSourceV1(client: Pick<typeof prisma, '$transaction'>): ContactIdentityMembershipSourcePortV1 {
  return {
    read(contactId, identityIds) {
      return client.$transaction(async tx => {
        const lineage = await createResolveContactLineageHandlerV1(makePrismaContactLineagePortV1(tx))(contactId)
        if (lineage === null) return null
        const contact = await tx.contact.findUnique({ where: { id: lineage.canonicalContactId }, select: { id: true, isArchived: true } })
        if (contact === null || contact.isArchived) return null
        const rows = await tx.contactIdentity.findMany({
          where: { id: { in: [...identityIds] } },
          select: { id: true, contactId: true, isActive: true, metadata: true },
        })
        return {
          canonicalContactId: contact.id,
          rows: rows.map(row => ({
            id: row.id,
            contactId: row.contactId,
            isActive: row.isActive,
            conflicted: identityEvidenceState(row.metadata).conflictState === 'conflicted',
          })),
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
    },
  }
}

export const legacyPrismaContactIdentityMembershipSourceV1 = makePrismaContactIdentityMembershipSourceV1(prisma)

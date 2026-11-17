// The reader behind contacts.ContactMergePreviewQuery.v1: the two Contacts
// exactly as the merge loads them — through the merge repositories' own
// findSourceContact / findTargetContact reads (the same include and
// normalization) — in one REPEATABLE READ snapshot. It never admits the
// ownership mutation, never locks and never writes.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { makeLegacyPrismaContactMergeRepositoriesV1 } from '../public/v1/legacy-prisma-contact-merge-adapter'
import type { ContactMergePreviewSourcePortV1 } from './contact-merge-preview'

export const legacyPrismaContactMergePreviewSourcesV1: ContactMergePreviewSourcePortV1 = (sourceId, targetId) =>
  prisma.$transaction(async (transaction) => {
    const { contacts } = makeLegacyPrismaContactMergeRepositoriesV1(transaction)
    const [source, target] = await Promise.all([
      contacts.findSourceContact(sourceId),
      contacts.findTargetContact(targetId),
    ])
    return { source, target }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })

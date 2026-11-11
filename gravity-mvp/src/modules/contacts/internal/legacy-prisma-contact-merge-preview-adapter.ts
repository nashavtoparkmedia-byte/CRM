// The reader behind contacts.ContactMergePreviewQuery.v1: the two Contacts
// exactly as the merge loads them (the merge adapter's own include and
// normalization), in one REPEATABLE READ snapshot. It neither admits an
// ownership mutation nor locks, and never writes.
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { contactMergeInclude, normalizeContactMergeRow } from '../public/v1/legacy-prisma-contact-merge-adapter'
import type { ContactMergePreviewSourcePortV1 } from './contact-merge-preview'

export const legacyPrismaContactMergePreviewSourcesV1: ContactMergePreviewSourcePortV1 = (sourceId, targetId) =>
  prisma.$transaction(async (transaction) => {
    const [source, target] = await Promise.all([
      transaction.contact.findUnique({ where: { id: sourceId }, include: contactMergeInclude }),
      transaction.contact.findUnique({ where: { id: targetId }, include: contactMergeInclude }),
    ])
    return { source: normalizeContactMergeRow(source), target: normalizeContactMergeRow(target) }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })

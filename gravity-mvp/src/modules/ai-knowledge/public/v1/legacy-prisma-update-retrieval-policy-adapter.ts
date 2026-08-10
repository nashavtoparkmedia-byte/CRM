import { prisma } from '@/lib/prisma'
import type { UpdateRetrievalPolicyPersistencePortV1 } from './update-retrieval-policy-handler'

export const legacyPrismaUpdateRetrievalPolicyPortV1: UpdateRetrievalPolicyPersistencePortV1 = {
  async update(input) {
    const patch = input.patch
    await prisma.$executeRawUnsafe(
      'UPDATE "AiRetrievalPolicy" SET "minConfidenceForReply" = CASE WHEN $1::boolean THEN $2::double precision ELSE "minConfidenceForReply" END, "sensitiveConfidenceMargin" = CASE WHEN $3::boolean THEN $4::double precision ELSE "sensitiveConfidenceMargin" END, "minSourceCountForReply" = CASE WHEN $5::boolean THEN $6::integer ELSE "minSourceCountForReply" END, "verifiedScoreBoost" = CASE WHEN $7::boolean THEN $8::double precision ELSE "verifiedScoreBoost" END, "excludeArchived" = CASE WHEN $9::boolean THEN $10::boolean ELSE "excludeArchived" END, "excludeSuperseded" = CASE WHEN $11::boolean THEN $12::boolean ELSE "excludeSuperseded" END, "excludeDraft" = CASE WHEN $13::boolean THEN $14::boolean ELSE "excludeDraft" END, "conflictEscalates" = CASE WHEN $15::boolean THEN $16::boolean ELSE "conflictEscalates" END, "rerankEnabled" = CASE WHEN $17::boolean THEN $18::boolean ELSE "rerankEnabled" END, "rerankTopN" = CASE WHEN $19::boolean THEN $20::integer ELSE "rerankTopN" END, "prefilterTopN" = CASE WHEN $21::boolean THEN $22::integer ELSE "prefilterTopN" END, "updatedAt" = NOW(), "updatedBy" = $23 WHERE id = \'singleton\'',
      patch.minConfidenceForReply !== undefined,
      patch.minConfidenceForReply === undefined ? null : patch.minConfidenceForReply,
      patch.sensitiveConfidenceMargin !== undefined,
      patch.sensitiveConfidenceMargin === undefined ? null : patch.sensitiveConfidenceMargin,
      patch.minSourceCountForReply !== undefined,
      patch.minSourceCountForReply === undefined ? null : patch.minSourceCountForReply,
      patch.verifiedScoreBoost !== undefined,
      patch.verifiedScoreBoost === undefined ? null : patch.verifiedScoreBoost,
      patch.excludeArchived !== undefined,
      patch.excludeArchived === undefined ? null : patch.excludeArchived,
      patch.excludeSuperseded !== undefined,
      patch.excludeSuperseded === undefined ? null : patch.excludeSuperseded,
      patch.excludeDraft !== undefined,
      patch.excludeDraft === undefined ? null : patch.excludeDraft,
      patch.conflictEscalates !== undefined,
      patch.conflictEscalates === undefined ? null : patch.conflictEscalates,
      patch.rerankEnabled !== undefined,
      patch.rerankEnabled === undefined ? null : patch.rerankEnabled,
      patch.rerankTopN !== undefined,
      patch.rerankTopN === undefined ? null : patch.rerankTopN,
      patch.prefilterTopN !== undefined,
      patch.prefilterTopN === undefined ? null : patch.prefilterTopN,
      input.actorId,
    )
  },
}

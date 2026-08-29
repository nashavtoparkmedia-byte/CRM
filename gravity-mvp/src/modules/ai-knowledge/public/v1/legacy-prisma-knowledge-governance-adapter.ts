import { prisma } from '@/lib/prisma'
import type { KnowledgeGovernancePersistencePortV1 } from './knowledge-governance-handler'

export const legacyPrismaKnowledgeGovernancePortV1: KnowledgeGovernancePersistencePortV1 = {
  async editItem(input) {
    const mask =
      (input.patch.title !== undefined ? 1 : 0)
      | (input.patch.canonicalStatement !== undefined ? 2 : 0)
      | (input.patch.tags !== undefined ? 4 : 0)
      | (input.patch.safetyLevel !== undefined ? 8 : 0)

    switch (mask) {
      case 1:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "title" = $1, "updatedAt" = NOW() WHERE id = $2',
          input.patch.title,
          input.itemId,
        )
        return
      case 2:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "canonicalStatement" = $1, "updatedAt" = NOW() WHERE id = $2',
          input.patch.canonicalStatement,
          input.itemId,
        )
        return
      case 3:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "title" = $1, "canonicalStatement" = $2, "updatedAt" = NOW() WHERE id = $3',
          input.patch.title,
          input.patch.canonicalStatement,
          input.itemId,
        )
        return
      case 4:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "tags" = $1::text[], "updatedAt" = NOW() WHERE id = $2',
          input.patch.tags,
          input.itemId,
        )
        return
      case 5:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "title" = $1, "tags" = $2::text[], "updatedAt" = NOW() WHERE id = $3',
          input.patch.title,
          input.patch.tags,
          input.itemId,
        )
        return
      case 6:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "canonicalStatement" = $1, "tags" = $2::text[], "updatedAt" = NOW() WHERE id = $3',
          input.patch.canonicalStatement,
          input.patch.tags,
          input.itemId,
        )
        return
      case 7:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "title" = $1, "canonicalStatement" = $2, "tags" = $3::text[], "updatedAt" = NOW() WHERE id = $4',
          input.patch.title,
          input.patch.canonicalStatement,
          input.patch.tags,
          input.itemId,
        )
        return
      case 8:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "safetyLevel" = $1::"AiKnowledgeSafety", "updatedAt" = NOW() WHERE id = $2',
          input.patch.safetyLevel,
          input.itemId,
        )
        return
      case 9:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "title" = $1, "safetyLevel" = $2::"AiKnowledgeSafety", "updatedAt" = NOW() WHERE id = $3',
          input.patch.title,
          input.patch.safetyLevel,
          input.itemId,
        )
        return
      case 10:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "canonicalStatement" = $1, "safetyLevel" = $2::"AiKnowledgeSafety", "updatedAt" = NOW() WHERE id = $3',
          input.patch.canonicalStatement,
          input.patch.safetyLevel,
          input.itemId,
        )
        return
      case 11:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "title" = $1, "canonicalStatement" = $2, "safetyLevel" = $3::"AiKnowledgeSafety", "updatedAt" = NOW() WHERE id = $4',
          input.patch.title,
          input.patch.canonicalStatement,
          input.patch.safetyLevel,
          input.itemId,
        )
        return
      case 12:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "tags" = $1::text[], "safetyLevel" = $2::"AiKnowledgeSafety", "updatedAt" = NOW() WHERE id = $3',
          input.patch.tags,
          input.patch.safetyLevel,
          input.itemId,
        )
        return
      case 13:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "title" = $1, "tags" = $2::text[], "safetyLevel" = $3::"AiKnowledgeSafety", "updatedAt" = NOW() WHERE id = $4',
          input.patch.title,
          input.patch.tags,
          input.patch.safetyLevel,
          input.itemId,
        )
        return
      case 14:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "canonicalStatement" = $1, "tags" = $2::text[], "safetyLevel" = $3::"AiKnowledgeSafety", "updatedAt" = NOW() WHERE id = $4',
          input.patch.canonicalStatement,
          input.patch.tags,
          input.patch.safetyLevel,
          input.itemId,
        )
        return
      case 15:
        await prisma.$executeRawUnsafe(
          'UPDATE "AiKnowledgeItem" SET "title" = $1, "canonicalStatement" = $2, "tags" = $3::text[], "safetyLevel" = $4::"AiKnowledgeSafety", "updatedAt" = NOW() WHERE id = $5',
          input.patch.title,
          input.patch.canonicalStatement,
          input.patch.tags,
          input.patch.safetyLevel,
          input.itemId,
        )
        return
      default:
        return
    }
  },

  async archiveItem(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiKnowledgeItem" SET status = \'archived\'::"AiKnowledgeStatus", "isActive" = false, "updatedAt" = NOW() WHERE id = $1',
      input.itemId,
    )
  },

  async restoreItem(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiKnowledgeItem" SET status = \'active\'::"AiKnowledgeStatus", "isActive" = true, "updatedAt" = NOW() WHERE id = $1',
      input.itemId,
    )
  },

  async verifyItem(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiKnowledgeItem" SET "isVerified" = true, "verifiedBy" = $1, "verifiedAt" = NOW(), "updatedAt" = NOW() WHERE id = $2',
      input.actorId,
      input.itemId,
    )
  },

  async unverifyItem(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiKnowledgeItem" SET "isVerified" = false, "verifiedBy" = NULL, "verifiedAt" = NULL, "updatedAt" = NOW() WHERE id = $1',
      input.itemId,
    )
  },

  async supersedeItem(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiKnowledgeItem" SET status = \'superseded\'::"AiKnowledgeStatus", "isActive" = false, "supersededByItemId" = $1, "updatedAt" = NOW() WHERE id = $2',
      input.newItemId,
      input.oldItemId,
    )
  },

  async archiveConflictMember(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiKnowledgeItem" SET status = \'archived\'::"AiKnowledgeStatus", "isActive" = false, "conflictGroupId" = NULL, "updatedAt" = NOW() WHERE id = $1',
      input.itemId,
    )
  },

  async clearConflictWinner(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiKnowledgeItem" SET "conflictGroupId" = NULL, "updatedAt" = NOW() WHERE id = $1',
      input.itemId,
    )
  },

  async clearConflictGroup(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiKnowledgeItem" SET "conflictGroupId" = NULL, "updatedAt" = NOW() WHERE "conflictGroupId" = $1',
      input.conflictGroupId,
    )
  },

  async createManualItem(input) {
    await prisma.$executeRawUnsafe(
      'INSERT INTO "AiKnowledgeItem" (id, "sectionId", title, "canonicalStatement", tags, confidence, "sourceCount", "uniqueManagerCount", status, "isActive", "safetyLevel", "isVerified", "verifiedBy", "verifiedAt", "createdBy", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5::text[], 0.95, 0, 0, \'active\'::"AiKnowledgeStatus", true, $6::"AiKnowledgeSafety", true, $7, NOW(), $8, NOW(), NOW())',
      input.itemId,
      input.sectionId,
      input.title,
      input.canonicalStatement,
      input.tags,
      input.safetyLevel,
      input.actorId,
      input.actorId,
    )
  },

  async markSourcesDisabled(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiKnowledgeItem" SET tags = array_append(tags, \'sources_all_disabled\'), "updatedAt" = NOW() WHERE id = $1',
      input.itemId,
    )
  },

  async archiveAfterSourceDisable(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiKnowledgeItem" SET status = \'archived\'::"AiKnowledgeStatus", "isActive" = false, "updatedAt" = NOW() WHERE id = $1',
      input.itemId,
    )
  },

  async archiveForCoreReset(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiKnowledgeItem" SET status = \'archived\'::"AiKnowledgeStatus", "isActive" = false, "updatedAt" = NOW() WHERE id = $1',
      input.itemId,
    )
  },
}

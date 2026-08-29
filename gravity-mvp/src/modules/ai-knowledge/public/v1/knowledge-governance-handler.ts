import {
  ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1,
  ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_RESULT_V1,
  ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_RESULT_V1,
  ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_RESULT_V1,
  CLEAR_KNOWLEDGE_CONFLICT_GROUP_RESULT_V1,
  CLEAR_KNOWLEDGE_CONFLICT_WINNER_RESULT_V1,
  CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1,
  EDIT_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1,
  MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_RESULT_V1,
  RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1,
  SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1,
  UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1,
  VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1,
  parseArchiveGovernanceKnowledgeItemCommandV1,
  parseArchiveKnowledgeConflictMemberCommandV1,
  parseArchiveKnowledgeItemAfterSourceDisableCommandV1,
  parseArchiveKnowledgeItemForCoreResetCommandV1,
  parseClearKnowledgeConflictGroupCommandV1,
  parseClearKnowledgeConflictWinnerCommandV1,
  parseCreateManualGovernanceKnowledgeItemCommandV1,
  parseEditGovernanceKnowledgeItemCommandV1,
  parseMarkKnowledgeItemSourcesDisabledCommandV1,
  parseRestoreGovernanceKnowledgeItemCommandV1,
  parseSupersedeGovernanceKnowledgeItemCommandV1,
  parseUnverifyGovernanceKnowledgeItemCommandV1,
  parseVerifyGovernanceKnowledgeItemCommandV1,
  type ArchiveGovernanceKnowledgeItemCommandV1,
  type ArchiveGovernanceKnowledgeItemResultV1,
  type ArchiveKnowledgeConflictMemberCommandV1,
  type ArchiveKnowledgeConflictMemberResultV1,
  type ArchiveKnowledgeItemAfterSourceDisableCommandV1,
  type ArchiveKnowledgeItemAfterSourceDisableResultV1,
  type ArchiveKnowledgeItemForCoreResetCommandV1,
  type ArchiveKnowledgeItemForCoreResetResultV1,
  type ClearKnowledgeConflictGroupCommandV1,
  type ClearKnowledgeConflictGroupResultV1,
  type ClearKnowledgeConflictWinnerCommandV1,
  type ClearKnowledgeConflictWinnerResultV1,
  type CreateManualGovernanceKnowledgeItemCommandV1,
  type CreateManualGovernanceKnowledgeItemResultV1,
  type EditGovernanceKnowledgeItemCommandV1,
  type EditGovernanceKnowledgeItemResultV1,
  type KnowledgeGovernanceEditPatchV1,
  type KnowledgeGovernanceSafetyLevelV1,
  type MarkKnowledgeItemSourcesDisabledCommandV1,
  type MarkKnowledgeItemSourcesDisabledResultV1,
  type RestoreGovernanceKnowledgeItemCommandV1,
  type RestoreGovernanceKnowledgeItemResultV1,
  type SupersedeGovernanceKnowledgeItemCommandV1,
  type SupersedeGovernanceKnowledgeItemResultV1,
  type UnverifyGovernanceKnowledgeItemCommandV1,
  type UnverifyGovernanceKnowledgeItemResultV1,
  type VerifyGovernanceKnowledgeItemCommandV1,
  type VerifyGovernanceKnowledgeItemResultV1,
} from '../../../../contracts/ai-knowledge/v1'

export interface KnowledgeGovernancePersistencePortV1 {
  editItem(input: { itemId: string; patch: KnowledgeGovernanceEditPatchV1 }): Promise<void>
  archiveItem(input: { itemId: string }): Promise<void>
  restoreItem(input: { itemId: string }): Promise<void>
  verifyItem(input: { itemId: string; actorId: string }): Promise<void>
  unverifyItem(input: { itemId: string }): Promise<void>
  supersedeItem(input: { oldItemId: string; newItemId: string }): Promise<void>
  archiveConflictMember(input: { itemId: string }): Promise<void>
  clearConflictWinner(input: { itemId: string }): Promise<void>
  clearConflictGroup(input: { conflictGroupId: string }): Promise<void>
  createManualItem(input: {
    itemId: string
    sectionId: string
    title: string
    canonicalStatement: string
    tags: string[]
    safetyLevel: KnowledgeGovernanceSafetyLevelV1
    actorId: string
  }): Promise<void>
  markSourcesDisabled(input: { itemId: string }): Promise<void>
  archiveAfterSourceDisable(input: { itemId: string }): Promise<void>
  archiveForCoreReset(input: { itemId: string }): Promise<void>
}

export function createEditGovernanceKnowledgeItemHandlerV1(
  port: KnowledgeGovernancePersistencePortV1,
) {
  return async function editGovernanceKnowledgeItemV1(
    command: EditGovernanceKnowledgeItemCommandV1 | unknown,
  ): Promise<EditGovernanceKnowledgeItemResultV1> {
    const parsed = parseEditGovernanceKnowledgeItemCommandV1(command)
    const updated = [
      parsed.patch.title,
      parsed.patch.canonicalStatement,
      parsed.patch.tags,
      parsed.patch.safetyLevel,
    ].some((value) => value !== undefined)
    if (updated) await port.editItem({ itemId: parsed.itemId, patch: parsed.patch })
    return { contract: EDIT_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1, updated }
  }
}

export function createArchiveGovernanceKnowledgeItemHandlerV1(
  port: KnowledgeGovernancePersistencePortV1,
) {
  return async function archiveGovernanceKnowledgeItemV1(
    command: ArchiveGovernanceKnowledgeItemCommandV1 | unknown,
  ): Promise<ArchiveGovernanceKnowledgeItemResultV1> {
    const parsed = parseArchiveGovernanceKnowledgeItemCommandV1(command)
    await port.archiveItem({ itemId: parsed.itemId })
    return { contract: ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1, updated: true }
  }
}

export function createRestoreGovernanceKnowledgeItemHandlerV1(
  port: KnowledgeGovernancePersistencePortV1,
) {
  return async function restoreGovernanceKnowledgeItemV1(
    command: RestoreGovernanceKnowledgeItemCommandV1 | unknown,
  ): Promise<RestoreGovernanceKnowledgeItemResultV1> {
    const parsed = parseRestoreGovernanceKnowledgeItemCommandV1(command)
    await port.restoreItem({ itemId: parsed.itemId })
    return { contract: RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1, updated: true }
  }
}

export function createVerifyGovernanceKnowledgeItemHandlerV1(
  port: KnowledgeGovernancePersistencePortV1,
) {
  return async function verifyGovernanceKnowledgeItemV1(
    command: VerifyGovernanceKnowledgeItemCommandV1 | unknown,
  ): Promise<VerifyGovernanceKnowledgeItemResultV1> {
    const parsed = parseVerifyGovernanceKnowledgeItemCommandV1(command)
    await port.verifyItem({ itemId: parsed.itemId, actorId: parsed.actorId })
    return { contract: VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1, updated: true }
  }
}

export function createUnverifyGovernanceKnowledgeItemHandlerV1(
  port: KnowledgeGovernancePersistencePortV1,
) {
  return async function unverifyGovernanceKnowledgeItemV1(
    command: UnverifyGovernanceKnowledgeItemCommandV1 | unknown,
  ): Promise<UnverifyGovernanceKnowledgeItemResultV1> {
    const parsed = parseUnverifyGovernanceKnowledgeItemCommandV1(command)
    await port.unverifyItem({ itemId: parsed.itemId })
    return { contract: UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1, updated: true }
  }
}

export function createSupersedeGovernanceKnowledgeItemHandlerV1(
  port: KnowledgeGovernancePersistencePortV1,
) {
  return async function supersedeGovernanceKnowledgeItemV1(
    command: SupersedeGovernanceKnowledgeItemCommandV1 | unknown,
  ): Promise<SupersedeGovernanceKnowledgeItemResultV1> {
    const parsed = parseSupersedeGovernanceKnowledgeItemCommandV1(command)
    await port.supersedeItem({ oldItemId: parsed.oldItemId, newItemId: parsed.newItemId })
    return { contract: SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1, updated: true }
  }
}

export function createArchiveKnowledgeConflictMemberHandlerV1(
  port: KnowledgeGovernancePersistencePortV1,
) {
  return async function archiveKnowledgeConflictMemberV1(
    command: ArchiveKnowledgeConflictMemberCommandV1 | unknown,
  ): Promise<ArchiveKnowledgeConflictMemberResultV1> {
    const parsed = parseArchiveKnowledgeConflictMemberCommandV1(command)
    await port.archiveConflictMember({ itemId: parsed.itemId })
    return { contract: ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_RESULT_V1, updated: true }
  }
}

export function createClearKnowledgeConflictWinnerHandlerV1(
  port: KnowledgeGovernancePersistencePortV1,
) {
  return async function clearKnowledgeConflictWinnerV1(
    command: ClearKnowledgeConflictWinnerCommandV1 | unknown,
  ): Promise<ClearKnowledgeConflictWinnerResultV1> {
    const parsed = parseClearKnowledgeConflictWinnerCommandV1(command)
    await port.clearConflictWinner({ itemId: parsed.itemId })
    return { contract: CLEAR_KNOWLEDGE_CONFLICT_WINNER_RESULT_V1, updated: true }
  }
}

export function createClearKnowledgeConflictGroupHandlerV1(
  port: KnowledgeGovernancePersistencePortV1,
) {
  return async function clearKnowledgeConflictGroupV1(
    command: ClearKnowledgeConflictGroupCommandV1 | unknown,
  ): Promise<ClearKnowledgeConflictGroupResultV1> {
    const parsed = parseClearKnowledgeConflictGroupCommandV1(command)
    await port.clearConflictGroup({ conflictGroupId: parsed.conflictGroupId })
    return { contract: CLEAR_KNOWLEDGE_CONFLICT_GROUP_RESULT_V1, updated: true }
  }
}

export function createCreateManualGovernanceKnowledgeItemHandlerV1(
  port: KnowledgeGovernancePersistencePortV1,
) {
  return async function createManualGovernanceKnowledgeItemV1(
    command: CreateManualGovernanceKnowledgeItemCommandV1 | unknown,
  ): Promise<CreateManualGovernanceKnowledgeItemResultV1> {
    const parsed = parseCreateManualGovernanceKnowledgeItemCommandV1(command)
    await port.createManualItem({
      itemId: parsed.itemId,
      sectionId: parsed.sectionId,
      title: parsed.title,
      canonicalStatement: parsed.canonicalStatement,
      tags: parsed.tags,
      safetyLevel: parsed.safetyLevel,
      actorId: parsed.actorId,
    })
    return { contract: CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_RESULT_V1, created: true }
  }
}

export function createMarkKnowledgeItemSourcesDisabledHandlerV1(
  port: KnowledgeGovernancePersistencePortV1,
) {
  return async function markKnowledgeItemSourcesDisabledV1(
    command: MarkKnowledgeItemSourcesDisabledCommandV1 | unknown,
  ): Promise<MarkKnowledgeItemSourcesDisabledResultV1> {
    const parsed = parseMarkKnowledgeItemSourcesDisabledCommandV1(command)
    await port.markSourcesDisabled({ itemId: parsed.itemId })
    return { contract: MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_RESULT_V1, updated: true }
  }
}

export function createArchiveKnowledgeItemAfterSourceDisableHandlerV1(
  port: KnowledgeGovernancePersistencePortV1,
) {
  return async function archiveKnowledgeItemAfterSourceDisableV1(
    command: ArchiveKnowledgeItemAfterSourceDisableCommandV1 | unknown,
  ): Promise<ArchiveKnowledgeItemAfterSourceDisableResultV1> {
    const parsed = parseArchiveKnowledgeItemAfterSourceDisableCommandV1(command)
    await port.archiveAfterSourceDisable({ itemId: parsed.itemId })
    return {
      contract: ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_RESULT_V1,
      updated: true,
    }
  }
}

export function createArchiveKnowledgeItemForCoreResetHandlerV1(
  port: KnowledgeGovernancePersistencePortV1,
) {
  return async function archiveKnowledgeItemForCoreResetV1(
    command: ArchiveKnowledgeItemForCoreResetCommandV1 | unknown,
  ): Promise<ArchiveKnowledgeItemForCoreResetResultV1> {
    const parsed = parseArchiveKnowledgeItemForCoreResetCommandV1(command)
    await port.archiveForCoreReset({ itemId: parsed.itemId })
    return { contract: ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_RESULT_V1, updated: true }
  }
}

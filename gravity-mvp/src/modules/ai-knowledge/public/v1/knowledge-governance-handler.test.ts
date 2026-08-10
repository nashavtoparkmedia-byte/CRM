import { describe, expect, it, vi } from 'vitest'
import {
  ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
  ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_COMMAND_V1,
  ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_COMMAND_V1,
  ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_COMMAND_V1,
  CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1,
  CLEAR_KNOWLEDGE_CONFLICT_WINNER_COMMAND_V1,
  CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
  EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
  MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_COMMAND_V1,
  RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
  SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
  UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
  VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
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
} from '../../../../contracts/ai-knowledge/v1'
import {
  createArchiveGovernanceKnowledgeItemHandlerV1,
  createArchiveKnowledgeConflictMemberHandlerV1,
  createArchiveKnowledgeItemAfterSourceDisableHandlerV1,
  createArchiveKnowledgeItemForCoreResetHandlerV1,
  createClearKnowledgeConflictGroupHandlerV1,
  createClearKnowledgeConflictWinnerHandlerV1,
  createCreateManualGovernanceKnowledgeItemHandlerV1,
  createEditGovernanceKnowledgeItemHandlerV1,
  createMarkKnowledgeItemSourcesDisabledHandlerV1,
  createRestoreGovernanceKnowledgeItemHandlerV1,
  createSupersedeGovernanceKnowledgeItemHandlerV1,
  createUnverifyGovernanceKnowledgeItemHandlerV1,
  createVerifyGovernanceKnowledgeItemHandlerV1,
  type KnowledgeGovernancePersistencePortV1,
} from './knowledge-governance-handler'

type ParserCase = {
  parse: (input: unknown) => unknown
  command: Record<string, unknown>
}

function makePort() {
  const methods = {
    editItem: vi.fn(async () => undefined),
    archiveItem: vi.fn(async () => undefined),
    restoreItem: vi.fn(async () => undefined),
    verifyItem: vi.fn(async () => undefined),
    unverifyItem: vi.fn(async () => undefined),
    supersedeItem: vi.fn(async () => undefined),
    archiveConflictMember: vi.fn(async () => undefined),
    clearConflictWinner: vi.fn(async () => undefined),
    clearConflictGroup: vi.fn(async () => undefined),
    createManualItem: vi.fn(async () => undefined),
    markSourcesDisabled: vi.fn(async () => undefined),
    archiveAfterSourceDisable: vi.fn(async () => undefined),
    archiveForCoreReset: vi.fn(async () => undefined),
  }
  return { methods, port: methods as KnowledgeGovernancePersistencePortV1 }
}

const parserCases: ParserCase[] = [
  {
    parse: parseEditGovernanceKnowledgeItemCommandV1,
    command: {
      contract: EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'item-edit',
      patch: {
        title: 'Title',
        canonicalStatement: 'Statement',
        tags: ['one'],
        safetyLevel: 'sensitive',
      },
    },
  },
  {
    parse: parseArchiveGovernanceKnowledgeItemCommandV1,
    command: { contract: ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1, itemId: 'item-archive' },
  },
  {
    parse: parseRestoreGovernanceKnowledgeItemCommandV1,
    command: { contract: RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1, itemId: 'item-restore' },
  },
  {
    parse: parseVerifyGovernanceKnowledgeItemCommandV1,
    command: {
      contract: VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'item-verify',
      actorId: 'actor-1',
    },
  },
  {
    parse: parseUnverifyGovernanceKnowledgeItemCommandV1,
    command: { contract: UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1, itemId: 'item-unverify' },
  },
  {
    parse: parseSupersedeGovernanceKnowledgeItemCommandV1,
    command: {
      contract: SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      oldItemId: 'old-item',
      newItemId: 'new-item',
    },
  },
  {
    parse: parseArchiveKnowledgeConflictMemberCommandV1,
    command: { contract: ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_COMMAND_V1, itemId: 'loser-item' },
  },
  {
    parse: parseClearKnowledgeConflictWinnerCommandV1,
    command: { contract: CLEAR_KNOWLEDGE_CONFLICT_WINNER_COMMAND_V1, itemId: 'winner-item' },
  },
  {
    parse: parseClearKnowledgeConflictGroupCommandV1,
    command: {
      contract: CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1,
      conflictGroupId: 'group-1',
    },
  },
  {
    parse: parseCreateManualGovernanceKnowledgeItemCommandV1,
    command: {
      contract: CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'manual-item',
      sectionId: 'section-1',
      title: 'Manual',
      canonicalStatement: 'Manual statement',
      tags: ['type:manual'],
      safetyLevel: 'normal',
      actorId: 'actor-1',
    },
  },
  {
    parse: parseMarkKnowledgeItemSourcesDisabledCommandV1,
    command: { contract: MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_COMMAND_V1, itemId: 'warn-item' },
  },
  {
    parse: parseArchiveKnowledgeItemAfterSourceDisableCommandV1,
    command: {
      contract: ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_COMMAND_V1,
      itemId: 'source-item',
    },
  },
  {
    parse: parseArchiveKnowledgeItemForCoreResetCommandV1,
    command: { contract: ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_COMMAND_V1, itemId: 'reset-item' },
  },
]

describe('AI Knowledge governance v1 contracts', () => {
  it('parses all 13 exact envelopes and rejects extra capabilities and future versions', () => {
    for (const { parse, command } of parserCases) {
      expect(parse(command)).toEqual(command)
      expect(() => parse({ ...command, sql: 'UPDATE anything' })).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONTRACT' }),
      )
      expect(() => parse({
        ...command,
        contract: String(command.contract).replace(/\.v1$/, '.v2'),
      })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_CONTRACT_VERSION' }))
    }
  })

  it('keeps DB-resolved legacy item identifiers string-only, not nonempty', () => {
    expect(parseArchiveGovernanceKnowledgeItemCommandV1({
      contract: ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: '',
    })).toEqual({ contract: ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1, itemId: '' })
    expect(parseSupersedeGovernanceKnowledgeItemCommandV1({
      contract: SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      oldItemId: '',
      newItemId: '',
    })).toEqual({
      contract: SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      oldItemId: '',
      newItemId: '',
    })
  })

  it('preserves legacy truthy whitespace identifiers outside trimmed content fields', () => {
    expect(parseVerifyGovernanceKnowledgeItemCommandV1({
      contract: VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'item',
      actorId: ' ',
    })).toEqual({
      contract: VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'item',
      actorId: ' ',
    })
    expect(parseClearKnowledgeConflictGroupCommandV1({
      contract: CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1,
      conflictGroupId: ' ',
    })).toEqual({
      contract: CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1,
      conflictGroupId: ' ',
    })
    expect(parseCreateManualGovernanceKnowledgeItemCommandV1({
      contract: CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'manual-item',
      sectionId: ' ',
      title: 'Title',
      canonicalStatement: 'Statement',
      tags: [],
      safetyLevel: 'normal',
      actorId: ' ',
    })).toMatchObject({ sectionId: ' ', actorId: ' ' })
  })

  it('closes edit patch shape and validates exact value types', () => {
    const base = { contract: EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1, itemId: 'item' }
    expect(() => parseEditGovernanceKnowledgeItemCommandV1({
      ...base,
      patch: { where: { id: 'other' } },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTRACT' }))
    expect(() => parseEditGovernanceKnowledgeItemCommandV1({
      ...base,
      patch: { tags: ['valid', 1] },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTRACT' }))
    expect(() => parseEditGovernanceKnowledgeItemCommandV1({
      ...base,
      patch: { safetyLevel: 'automatic' },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTRACT' }))
  })
})

describe('AI Knowledge governance v1 handlers', () => {
  it('maps every command to its one named semantic persistence method', async () => {
    const { methods, port } = makePort()

    await createEditGovernanceKnowledgeItemHandlerV1(port)({
      contract: EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'edit',
      patch: { title: 'Title', tags: ['one'] },
    })
    expect(methods.editItem).toHaveBeenCalledWith({
      itemId: 'edit',
      patch: { title: 'Title', tags: ['one'] },
    })

    await createArchiveGovernanceKnowledgeItemHandlerV1(port)({
      contract: ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'archive',
    })
    expect(methods.archiveItem).toHaveBeenCalledWith({ itemId: 'archive' })

    await createRestoreGovernanceKnowledgeItemHandlerV1(port)({
      contract: RESTORE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'restore',
    })
    expect(methods.restoreItem).toHaveBeenCalledWith({ itemId: 'restore' })

    await createVerifyGovernanceKnowledgeItemHandlerV1(port)({
      contract: VERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'verify',
      actorId: 'actor',
    })
    expect(methods.verifyItem).toHaveBeenCalledWith({ itemId: 'verify', actorId: 'actor' })

    await createUnverifyGovernanceKnowledgeItemHandlerV1(port)({
      contract: UNVERIFY_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'unverify',
    })
    expect(methods.unverifyItem).toHaveBeenCalledWith({ itemId: 'unverify' })

    await createSupersedeGovernanceKnowledgeItemHandlerV1(port)({
      contract: SUPERSEDE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      oldItemId: 'old',
      newItemId: 'new',
    })
    expect(methods.supersedeItem).toHaveBeenCalledWith({ oldItemId: 'old', newItemId: 'new' })

    await createArchiveKnowledgeConflictMemberHandlerV1(port)({
      contract: ARCHIVE_KNOWLEDGE_CONFLICT_MEMBER_COMMAND_V1,
      itemId: 'loser',
    })
    expect(methods.archiveConflictMember).toHaveBeenCalledWith({ itemId: 'loser' })

    await createClearKnowledgeConflictWinnerHandlerV1(port)({
      contract: CLEAR_KNOWLEDGE_CONFLICT_WINNER_COMMAND_V1,
      itemId: 'winner',
    })
    expect(methods.clearConflictWinner).toHaveBeenCalledWith({ itemId: 'winner' })

    await createClearKnowledgeConflictGroupHandlerV1(port)({
      contract: CLEAR_KNOWLEDGE_CONFLICT_GROUP_COMMAND_V1,
      conflictGroupId: 'group',
    })
    expect(methods.clearConflictGroup).toHaveBeenCalledWith({ conflictGroupId: 'group' })

    await createCreateManualGovernanceKnowledgeItemHandlerV1(port)({
      contract: CREATE_MANUAL_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'manual',
      sectionId: 'section',
      title: 'Title',
      canonicalStatement: 'Statement',
      tags: ['type:manual'],
      safetyLevel: 'normal',
      actorId: 'actor',
    })
    expect(methods.createManualItem).toHaveBeenCalledWith({
      itemId: 'manual',
      sectionId: 'section',
      title: 'Title',
      canonicalStatement: 'Statement',
      tags: ['type:manual'],
      safetyLevel: 'normal',
      actorId: 'actor',
    })

    await createMarkKnowledgeItemSourcesDisabledHandlerV1(port)({
      contract: MARK_KNOWLEDGE_ITEM_SOURCES_DISABLED_COMMAND_V1,
      itemId: 'warn',
    })
    expect(methods.markSourcesDisabled).toHaveBeenCalledWith({ itemId: 'warn' })

    await createArchiveKnowledgeItemAfterSourceDisableHandlerV1(port)({
      contract: ARCHIVE_KNOWLEDGE_ITEM_AFTER_SOURCE_DISABLE_COMMAND_V1,
      itemId: 'source',
    })
    expect(methods.archiveAfterSourceDisable).toHaveBeenCalledWith({ itemId: 'source' })

    await createArchiveKnowledgeItemForCoreResetHandlerV1(port)({
      contract: ARCHIVE_KNOWLEDGE_ITEM_FOR_CORE_RESET_COMMAND_V1,
      itemId: 'reset',
    })
    expect(methods.archiveForCoreReset).toHaveBeenCalledWith({ itemId: 'reset' })
  })

  it('does not persist an edit whose four supported values are all undefined', async () => {
    const { methods, port } = makePort()
    await expect(createEditGovernanceKnowledgeItemHandlerV1(port)({
      contract: EDIT_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'item',
      patch: { title: undefined, tags: undefined },
    })).resolves.toMatchObject({ updated: false })
    expect(methods.editItem).not.toHaveBeenCalled()
  })

  it('validates before persistence and leaves owner failures visible', async () => {
    const { methods, port } = makePort()
    await expect(createArchiveGovernanceKnowledgeItemHandlerV1(port)({
      contract: ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'item',
      sql: 'UPDATE anything',
    })).rejects.toMatchObject({ code: 'INVALID_CONTRACT' })
    expect(methods.archiveItem).not.toHaveBeenCalled()

    methods.archiveItem.mockRejectedValueOnce(new Error('owner down'))
    await expect(createArchiveGovernanceKnowledgeItemHandlerV1(port)({
      contract: ARCHIVE_GOVERNANCE_KNOWLEDGE_ITEM_COMMAND_V1,
      itemId: 'item',
    })).rejects.toThrow('owner down')
  })
})

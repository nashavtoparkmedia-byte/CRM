import {
    CREATE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1,
    DELETE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1,
    UPDATE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1,
    parseCreateLegacyKnowledgeEntryCommandV1,
    parseDeleteLegacyKnowledgeEntryCommandV1,
    parseUpdateLegacyKnowledgeEntryCommandV1,
    type CreateLegacyKnowledgeEntryCommandV1,
    type CreateLegacyKnowledgeEntryResultV1,
    type DeleteLegacyKnowledgeEntryCommandV1,
    type DeleteLegacyKnowledgeEntryResultV1,
    type LegacyKnowledgeEntryCreateV1,
    type LegacyKnowledgeEntryPatchV1,
    type UpdateLegacyKnowledgeEntryCommandV1,
    type UpdateLegacyKnowledgeEntryResultV1,
} from '../../../../contracts/ai-knowledge/v1'

export interface LegacyKnowledgeEntryPersistencePortV1 {
    create(entryId: string, data: LegacyKnowledgeEntryCreateV1): Promise<void>
    update(entryId: string, patch: LegacyKnowledgeEntryPatchV1): Promise<void>
    delete(entryId: string): Promise<void>
}

export function createCreateLegacyKnowledgeEntryHandlerV1(port: LegacyKnowledgeEntryPersistencePortV1) {
    return async function createLegacyKnowledgeEntryV1(
        command: CreateLegacyKnowledgeEntryCommandV1 | unknown,
    ): Promise<CreateLegacyKnowledgeEntryResultV1> {
        const parsed = parseCreateLegacyKnowledgeEntryCommandV1(command)
        await port.create(parsed.entryId, parsed.data)
        return { contract: CREATE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1, created: true }
    }
}

export function createUpdateLegacyKnowledgeEntryHandlerV1(port: LegacyKnowledgeEntryPersistencePortV1) {
    return async function updateLegacyKnowledgeEntryV1(
        command: UpdateLegacyKnowledgeEntryCommandV1 | unknown,
    ): Promise<UpdateLegacyKnowledgeEntryResultV1> {
        const parsed = parseUpdateLegacyKnowledgeEntryCommandV1(command)
        const updated = Object.keys(parsed.patch).length > 0
        if (updated) await port.update(parsed.entryId, parsed.patch)
        return { contract: UPDATE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1, updated }
    }
}

export function createDeleteLegacyKnowledgeEntryHandlerV1(port: LegacyKnowledgeEntryPersistencePortV1) {
    return async function deleteLegacyKnowledgeEntryV1(
        command: DeleteLegacyKnowledgeEntryCommandV1 | unknown,
    ): Promise<DeleteLegacyKnowledgeEntryResultV1> {
        const parsed = parseDeleteLegacyKnowledgeEntryCommandV1(command)
        await port.delete(parsed.entryId)
        return { contract: DELETE_LEGACY_KNOWLEDGE_ENTRY_RESULT_V1, deleted: true }
    }
}

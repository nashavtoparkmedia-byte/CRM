import {
    getKnowledgeAuditLog,
    snapshotItem,
    writeAuditEntry,
    type AiKnowledgeAuditAction,
    type AuditEntryInput,
    type AuditEntryRow,
} from '@/lib/ai/knowledge/auditLog'

export type {
    AiKnowledgeAuditAction as KnowledgeGovernanceAuditActionV1,
    AuditEntryInput as KnowledgeGovernanceAuditInputV1,
    AuditEntryRow as KnowledgeGovernanceAuditRowV1,
}

export async function appendKnowledgeGovernanceAuditV1(
    input: AuditEntryInput,
): Promise<string | null> {
    return writeAuditEntry(input)
}

export function snapshotKnowledgeGovernanceItemV1(
    row: unknown,
): Record<string, unknown> {
    return snapshotItem(row)
}

export async function listKnowledgeGovernanceAuditV1(
    itemId: string,
    limit = 50,
): Promise<AuditEntryRow[]> {
    return getKnowledgeAuditLog(itemId, limit)
}

import {
    getLegacyMigrationPreviewCore,
    migrateLegacyKnowledgeBaseCore,
    type LegacyMigrationPreview,
    type LegacyMigrationResult,
} from '@/lib/ai/knowledge/legacyMigration'

export type {
    LegacyMigrationPreview as KnowledgeLegacyMigrationPreviewV1,
    LegacyMigrationResult as KnowledgeLegacyMigrationResultV1,
}

export async function previewKnowledgeLegacyMigrationV1(): Promise<LegacyMigrationPreview> {
    return getLegacyMigrationPreviewCore()
}

export async function executeKnowledgeLegacyMigrationV1(
    actorId: string,
): Promise<LegacyMigrationResult> {
    return migrateLegacyKnowledgeBaseCore(actorId)
}

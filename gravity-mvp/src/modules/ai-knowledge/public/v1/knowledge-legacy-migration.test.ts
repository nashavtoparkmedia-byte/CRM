import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    getLegacyMigrationPreviewCore: vi.fn(),
    migrateLegacyKnowledgeBaseCore: vi.fn(),
}))

vi.mock('@/lib/ai/knowledge/legacyMigration', () => operations)

import {
    executeKnowledgeLegacyMigrationV1,
    previewKnowledgeLegacyMigrationV1,
} from './knowledge-legacy-migration'

describe('AI Knowledge legacy migration capability', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('delegates the fixed read-only preview without inputs', async () => {
        const preview = { legacyTotalActive: 2, alreadyMigrated: 1, toMigrate: 1, bySection: [] }
        operations.getLegacyMigrationPreviewCore.mockResolvedValueOnce(preview)

        await expect(previewKnowledgeLegacyMigrationV1()).resolves.toBe(preview)
        expect(operations.getLegacyMigrationPreviewCore).toHaveBeenCalledWith()
    })

    it('delegates one authenticated actor to the idempotent migration plan', async () => {
        const result = { migrated: 1, skipped: 0, failed: 0, errors: [] }
        operations.migrateLegacyKnowledgeBaseCore.mockResolvedValueOnce(result)

        await expect(executeKnowledgeLegacyMigrationV1('user-1')).resolves.toBe(result)
        expect(operations.migrateLegacyKnowledgeBaseCore).toHaveBeenCalledWith('user-1')
    })
})

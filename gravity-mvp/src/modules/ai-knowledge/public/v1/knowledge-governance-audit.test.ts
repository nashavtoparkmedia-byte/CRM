import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    getKnowledgeAuditLog: vi.fn(),
    snapshotItem: vi.fn(),
    writeAuditEntry: vi.fn(),
}))

vi.mock('@/lib/ai/knowledge/auditLog', () => operations)

import {
    appendKnowledgeGovernanceAuditV1,
    listKnowledgeGovernanceAuditV1,
    snapshotKnowledgeGovernanceItemV1,
} from './knowledge-governance-audit'

describe('AI Knowledge governance audit boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('delegates one closed-action append entry without changing best-effort result semantics', async () => {
        const entry = { itemId: 'item-1', actor: 'user-1', action: 'verified' as const }
        operations.writeAuditEntry.mockResolvedValueOnce('audit-1')

        await expect(appendKnowledgeGovernanceAuditV1(entry)).resolves.toBe('audit-1')
        expect(operations.writeAuditEntry).toHaveBeenCalledWith(entry)
    })

    it('uses the canonical governance snapshot projection', () => {
        const item = { id: 'item-1', title: 'Title' }
        const snapshot = { title: 'Title' }
        operations.snapshotItem.mockReturnValueOnce(snapshot)

        expect(snapshotKnowledgeGovernanceItemV1(item)).toBe(snapshot)
        expect(operations.snapshotItem).toHaveBeenCalledWith(item)
    })

    it('keeps audit history bounded to the existing default', async () => {
        const rows = [{ id: 'audit-1' }]
        operations.getKnowledgeAuditLog.mockResolvedValueOnce(rows)

        await expect(listKnowledgeGovernanceAuditV1('item-1')).resolves.toBe(rows)
        expect(operations.getKnowledgeAuditLog).toHaveBeenCalledWith('item-1', 50)
    })
})

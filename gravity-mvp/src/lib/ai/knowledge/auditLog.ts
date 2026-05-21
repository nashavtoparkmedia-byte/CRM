/**
 * AI Knowledge Core — audit logger (PR2.5).
 *
 * Lightweight трейл governance-действий админа. JSON snapshots
 * до/после, не diff. Использует прямой $executeRaw — без $transaction'ов,
 * чтобы сбой audit-записи не откатывал основной mutation. Audit
 * best-effort.
 *
 * Extractor (PR2) НЕ пишет audit для своих автосозданных items — это
 * implicit через AiKnowledgeSource. Audit только для governance.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { prisma } from '@/lib/prisma'

export type AiKnowledgeAuditAction =
    | 'created'
    | 'manual_created'
    | 'edited'
    | 'archived'
    | 'restored'
    | 'verified'
    | 'unverified'
    | 'superseded'
    | 'conflict_resolved'
    | 'source_added'
    // PR7.7 — soft-disable знаний с конкретного источника
    | 'source_disabled'
    // PR7.8 — массовый reset ядра (auto_only / unverified / full)
    | 'core_reset'

export interface AuditEntryInput {
    itemId:    string | null
    actor:     string | null
    action:    AiKnowledgeAuditAction
    before?:   Record<string, unknown> | null
    after?:    Record<string, unknown> | null
    metadata?: Record<string, unknown>
}

export interface AuditEntryRow {
    id:         string
    itemId:     string | null
    actor:      string | null
    action:     AiKnowledgeAuditAction
    beforeJson: Record<string, unknown> | null
    afterJson:  Record<string, unknown> | null
    metadata:   Record<string, unknown> | null
    createdAt:  string
}

/**
 * Пишет одну audit-запись. Tolerant: при ошибке логирует в console и
 * возвращает null. Не throw — основная mutation не должна откатываться
 * из-за сбоя в audit-логе.
 */
export async function writeAuditEntry(input: AuditEntryInput): Promise<string | null> {
    const id = 'aud_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
    const beforeJson = input.before ? JSON.stringify(input.before) : null
    const afterJson  = input.after  ? JSON.stringify(input.after)  : null
    const metaJson   = input.metadata ? JSON.stringify(input.metadata) : null

    try {
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeAuditLog" (
                id, "itemId", actor, action,
                "beforeJson", "afterJson", metadata, "createdAt"
            ) VALUES (
                ${id},
                ${input.itemId},
                ${input.actor},
                ${input.action}::"AiKnowledgeAuditAction",
                ${beforeJson}::jsonb,
                ${afterJson}::jsonb,
                ${metaJson}::jsonb,
                NOW()
            )
        `
        return id
    } catch (e: any) {
        console.error('[auditLog] writeAuditEntry failed:', e?.message)
        return null
    }
}

/**
 * Каноничный набор полей item'а для audit before/after. Включает всё
 * governance-релевантное без раздувания.
 */
export function snapshotItem(row: any): Record<string, unknown> {
    if (!row) return {}
    return {
        title:              row.title,
        canonicalStatement: row.canonicalStatement,
        tags:               row.tags,
        safetyLevel:        row.safetyLevel,
        status:             row.status,
        isActive:           row.isActive,
        isVerified:         row.isVerified,
        verifiedBy:         row.verifiedBy,
        verifiedAt:         row.verifiedAt,
        supersededByItemId: row.supersededByItemId,
        conflictGroupId:    row.conflictGroupId,
        confidence:         row.confidence,
        sourceCount:        row.sourceCount,
        uniqueManagerCount: row.uniqueManagerCount,
    }
}

/**
 * Audit history по item для UI "История изменений".
 * В обратном хронологическом порядке.
 */
export async function getKnowledgeAuditLog(
    itemId: string,
    limit = 50,
): Promise<AuditEntryRow[]> {
    try {
        return await prisma.$queryRaw<AuditEntryRow[]>`
            SELECT
                id, "itemId", actor,
                action::text  AS action,
                "beforeJson", "afterJson", metadata,
                "createdAt"
            FROM "AiKnowledgeAuditLog"
            WHERE "itemId" = ${itemId}
            ORDER BY "createdAt" DESC
            LIMIT ${limit}
        `
    } catch {
        return []
    }
}

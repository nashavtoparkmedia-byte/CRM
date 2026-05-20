/* eslint-disable no-console */
/**
 * Rollback Knowledge Core БД до состояния ДО PR1.
 *
 * Контекст: после `git pull origin main --ff-only` файлы PR1-PR5
 * исчезли из репозитория, но миграции в БД остались применены.
 * Этот скрипт приводит БД в соответствие с актуальным main.
 *
 * Что делает:
 *   1. DROP 7 таблиц Knowledge Core (через CASCADE снимаются FK + indexes)
 *   2. ALTER TABLE — убирает PR2.1/PR3.1/PR5.1 колонки из существующих таблиц
 *   3. DROP TYPE — удаляет 6 enums
 *   4. DELETE из _prisma_migrations 5 записей PR1-PR5
 *
 * Безопасно повторно запускать (использует IF EXISTS везде).
 *
 * Запуск: cd D:/Github/CRM/gravity-mvp && node scripts/rollback_knowledge_core.js
 */

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const STEPS = [
    // ─── 1. DROP таблиц ──────────────────────────────────────────
    {
        name: 'DROP AiKnowledgeAuditLog',
        sql: 'DROP TABLE IF EXISTS "AiKnowledgeAuditLog" CASCADE',
    },
    {
        name: 'DROP AiRetrievalPolicy',
        sql: 'DROP TABLE IF EXISTS "AiRetrievalPolicy" CASCADE',
    },
    {
        name: 'DROP AiKnowledgeUsageLog',
        sql: 'DROP TABLE IF EXISTS "AiKnowledgeUsageLog" CASCADE',
    },
    {
        name: 'DROP AiKnowledgeSource',
        sql: 'DROP TABLE IF EXISTS "AiKnowledgeSource" CASCADE',
    },
    {
        name: 'DROP AiKnowledgeItem',
        sql: 'DROP TABLE IF EXISTS "AiKnowledgeItem" CASCADE',
    },
    {
        name: 'DROP AiKnowledgeSection',
        sql: 'DROP TABLE IF EXISTS "AiKnowledgeSection" CASCADE',
    },
    {
        name: 'DROP AiExtractionJob',
        sql: 'DROP TABLE IF EXISTS "AiExtractionJob" CASCADE',
    },

    // ─── 2. ALTER существующих таблиц ────────────────────────────
    // KnowledgeBaseEntry — убираем PR5.1 marker
    {
        name: 'DROP index KnowledgeBaseEntry_migratedToItemId_idx',
        sql: 'DROP INDEX IF EXISTS "KnowledgeBaseEntry_migratedToItemId_idx"',
    },
    {
        name: 'ALTER KnowledgeBaseEntry DROP migratedToItemId',
        sql: 'ALTER TABLE "KnowledgeBaseEntry" DROP COLUMN IF EXISTS "migratedToItemId"',
    },

    // AiAgentConfig — убираем PR2.1 + PR5.1 поля
    {
        name: 'ALTER AiAgentConfig DROP extractionQualityTier',
        sql: 'ALTER TABLE "AiAgentConfig" DROP COLUMN IF EXISTS "extractionQualityTier"',
    },
    {
        name: 'ALTER AiAgentConfig DROP extractionPromptVersion',
        sql: 'ALTER TABLE "AiAgentConfig" DROP COLUMN IF EXISTS "extractionPromptVersion"',
    },
    {
        name: 'ALTER AiAgentConfig DROP legacyKbHidden',
        sql: 'ALTER TABLE "AiAgentConfig" DROP COLUMN IF EXISTS "legacyKbHidden"',
    },

    // AiDecisionLog — убираем PR3.1 поля
    {
        name: 'DROP index AiDecisionLog_retrievalMode_createdAt_idx',
        sql: 'DROP INDEX IF EXISTS "AiDecisionLog_retrievalMode_createdAt_idx"',
    },
    {
        name: 'ALTER AiDecisionLog DROP retrievalMode',
        sql: 'ALTER TABLE "AiDecisionLog" DROP COLUMN IF EXISTS "retrievalMode"',
    },
    {
        name: 'ALTER AiDecisionLog DROP retrievalDecision',
        sql: 'ALTER TABLE "AiDecisionLog" DROP COLUMN IF EXISTS "retrievalDecision"',
    },
    {
        name: 'ALTER AiDecisionLog DROP escalationReason',
        sql: 'ALTER TABLE "AiDecisionLog" DROP COLUMN IF EXISTS "escalationReason"',
    },
    {
        name: 'ALTER AiDecisionLog DROP knowledgeRuntimeVersion',
        sql: 'ALTER TABLE "AiDecisionLog" DROP COLUMN IF EXISTS "knowledgeRuntimeVersion"',
    },
    {
        name: 'ALTER AiDecisionLog DROP shadowRetrievalSummary',
        sql: 'ALTER TABLE "AiDecisionLog" DROP COLUMN IF EXISTS "shadowRetrievalSummary"',
    },

    // ─── 3. DROP enums ───────────────────────────────────────────
    {
        name: 'DROP TYPE AiKnowledgeStatus',
        sql: 'DROP TYPE IF EXISTS "AiKnowledgeStatus" CASCADE',
    },
    {
        name: 'DROP TYPE AiKnowledgeSafety',
        sql: 'DROP TYPE IF EXISTS "AiKnowledgeSafety" CASCADE',
    },
    {
        name: 'DROP TYPE AiKnowledgeSourceOrigin',
        sql: 'DROP TYPE IF EXISTS "AiKnowledgeSourceOrigin" CASCADE',
    },
    {
        name: 'DROP TYPE AiKnowledgeRuntime',
        sql: 'DROP TYPE IF EXISTS "AiKnowledgeRuntime" CASCADE',
    },
    {
        name: 'DROP TYPE AiExtractionStatus',
        sql: 'DROP TYPE IF EXISTS "AiExtractionStatus" CASCADE',
    },
    {
        name: 'DROP TYPE AiKnowledgeAuditAction',
        sql: 'DROP TYPE IF EXISTS "AiKnowledgeAuditAction" CASCADE',
    },

    // ─── 4. DELETE из _prisma_migrations ─────────────────────────
    {
        name: 'DELETE _prisma_migrations: 5 PR1-PR5 entries',
        sql: `DELETE FROM _prisma_migrations WHERE migration_name IN (
            '20260520230000_add_ai_knowledge_core_foundation',
            '20260520240000_add_extraction_snapshot_fields',
            '20260520250000_add_knowledge_governance',
            '20260520260000_add_retrieval_policy_and_traces',
            '20260520270000_add_legacy_kb_migration_fields'
        )`,
    },
]

async function main() {
    console.log('[rollback] Starting Knowledge Core rollback...')
    console.log('[rollback] Verifying DB connection...')
    await prisma.$queryRaw`SELECT 1`
    console.log('[rollback] DB OK.')

    let done = 0
    let failed = 0
    for (const step of STEPS) {
        try {
            await prisma.$executeRawUnsafe(step.sql)
            console.log(`  ✓ ${step.name}`)
            done++
        } catch (e) {
            console.log(`  ✗ ${step.name} — ${e.message}`)
            failed++
        }
    }

    console.log(`\n[rollback] Done. steps_ok=${done} failed=${failed}`)

    // Verification
    const remainingTables = await prisma.$queryRaw`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema='public'
          AND table_name IN ('AiKnowledgeSection','AiKnowledgeItem','AiKnowledgeSource',
                             'AiKnowledgeUsageLog','AiExtractionJob','AiRetrievalPolicy',
                             'AiKnowledgeAuditLog')
    `
    const remainingMigrations = await prisma.$queryRaw`
        SELECT migration_name FROM _prisma_migrations
        WHERE migration_name IN (
            '20260520230000_add_ai_knowledge_core_foundation',
            '20260520240000_add_extraction_snapshot_fields',
            '20260520250000_add_knowledge_governance',
            '20260520260000_add_retrieval_policy_and_traces',
            '20260520270000_add_legacy_kb_migration_fields'
        )
    `
    console.log(`[rollback] Verify: knowledge tables remaining = ${remainingTables.length} (expect 0)`)
    console.log(`[rollback] Verify: PR1-PR5 migration rows remaining = ${remainingMigrations.length} (expect 0)`)

    if (remainingTables.length === 0 && remainingMigrations.length === 0) {
        console.log('[rollback] SUCCESS — БД синхронизирована с актуальным main.')
    } else {
        console.log('[rollback] WARNING — что-то осталось, проверь вручную.')
        process.exit(1)
    }
}

main()
    .catch(e => { console.error('[rollback] FAILED:', e.message); process.exit(1) })
    .finally(async () => { await prisma.$disconnect() })

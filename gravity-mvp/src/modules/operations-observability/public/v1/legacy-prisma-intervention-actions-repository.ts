import { prisma } from '@/lib/prisma'
import type {
    CompletedInterventionTimeV1,
    InterventionOutcomeCountV1,
    LatestInterventionActionV1,
    PendingInterventionActionV1,
} from '../../../../contracts/operations-observability/v1'
import type { InterventionActionsRepositoryPortV1 } from './intervention-actions-repository-handler'

const ENSURE_INTERVENTION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS intervention_actions (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  score_at_action INTEGER,
  outcome TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

const ENSURE_INTERVENTION_COLUMNS_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'intervention_actions' AND column_name = 'score_at_action') THEN
    ALTER TABLE intervention_actions ADD COLUMN score_at_action INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'intervention_actions' AND column_name = 'outcome') THEN
    ALTER TABLE intervention_actions ADD COLUMN outcome TEXT;
  END IF;
END $$`

const ENSURE_INTERVENTION_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_intervention_actions_manager
ON intervention_actions (manager_id, created_at DESC)`

let interventionTableEnsured = false

async function ensureInterventionTable() {
    if (interventionTableEnsured) return
    await prisma.$executeRawUnsafe(ENSURE_INTERVENTION_TABLE_SQL)
    await prisma.$executeRawUnsafe(ENSURE_INTERVENTION_COLUMNS_SQL)
    await prisma.$executeRawUnsafe(ENSURE_INTERVENTION_INDEX_SQL)
    interventionTableEnsured = true
}

export const legacyPrismaInterventionActionsRepositoryPortV1: InterventionActionsRepositoryPortV1 = {
    async ensure() {
        await ensureInterventionTable()
    },

    async create(input) {
        await ensureInterventionTable()
        await prisma.intervention_actions.create({
            data: {
                id: input.id,
                manager_id: input.managerId,
                action: input.action,
                comment: input.comment,
                score_at_action: input.scoreAtAction,
            },
        })
    },

    async listPending(eligibleAtOrBefore) {
        await ensureInterventionTable()
        const rows = await prisma.$queryRawUnsafe<Array<{
            id: string
            manager_id: string
            score_at_action: number
        }>>(`
            SELECT id, manager_id, score_at_action
            FROM intervention_actions
            WHERE outcome IS NULL AND score_at_action IS NOT NULL AND created_at <= $1
        `, eligibleAtOrBefore)
        return rows.map((row): PendingInterventionActionV1 => ({
            id: row.id,
            managerId: row.manager_id,
            scoreAtAction: row.score_at_action,
        }))
    },

    async setOutcome(input) {
        await ensureInterventionTable()
        await prisma.intervention_actions.updateMany({
            where: { id: input.id },
            data: { outcome: input.outcome },
        })
    },

    async listLatest() {
        await ensureInterventionTable()
        const rows = await prisma.$queryRawUnsafe<Array<{
            manager_id: string
            action: string
            comment: string | null
            score_at_action: number | null
            outcome: string | null
            created_at: Date
        }>>(`
            SELECT DISTINCT ON (manager_id) manager_id, action, comment, score_at_action, outcome, created_at
            FROM intervention_actions
            ORDER BY manager_id, created_at DESC
        `)
        return rows.map((row): LatestInterventionActionV1 => ({
            managerId: row.manager_id,
            action: row.action,
            comment: row.comment,
            scoreAtAction: row.score_at_action,
            outcome: row.outcome,
            createdAt: row.created_at,
        }))
    },

    async listOutcomeCounts() {
        await ensureInterventionTable()
        const rows = await prisma.$queryRawUnsafe<Array<{
            action: string
            outcome: string
            cnt: string
        }>>(`
            SELECT action, outcome, COUNT(*)::text as cnt
            FROM intervention_actions
            WHERE outcome IS NOT NULL
            GROUP BY action, outcome
            ORDER BY action, outcome
        `)
        return rows.map((row): InterventionOutcomeCountV1 => ({
            action: row.action,
            outcome: row.outcome,
            total: row.cnt,
        }))
    },

    async listCompletedTimes() {
        await ensureInterventionTable()
        const rows = await prisma.$queryRawUnsafe<Array<{ created_at: Date }>>(`
            SELECT created_at
            FROM intervention_actions
            WHERE outcome IS NOT NULL
            ORDER BY created_at DESC
        `)
        return rows.map((row): CompletedInterventionTimeV1 => ({ createdAt: row.created_at }))
    },
}

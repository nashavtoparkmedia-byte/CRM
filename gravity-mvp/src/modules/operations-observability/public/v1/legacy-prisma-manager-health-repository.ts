import { prisma } from '@/lib/prisma'
import type {
    ManagerHealthHistoryPointV1,
    ManagerHealthScoreInputV1,
    ManagerHealthSnapshotV1,
} from '../../../../contracts/operations-observability/v1'
import type { ManagerHealthRepositoryPortV1 } from './manager-health-repository-handler'

const ENSURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS health_snapshots (
  manager_id TEXT PRIMARY KEY,
  score INTEGER NOT NULL,
  decline_streak INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

const ENSURE_COLUMN_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'health_snapshots' AND column_name = 'decline_streak'
  ) THEN
    ALTER TABLE health_snapshots ADD COLUMN decline_streak INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$`

const ENSURE_HISTORY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS health_score_history (
  id SERIAL PRIMARY KEY,
  manager_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  health_level TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

const ENSURE_HISTORY_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_hsh_manager_date
  ON health_score_history (manager_id, recorded_at DESC)`

const LIST_SNAPSHOTS_SQL = 'SELECT manager_id, score, decline_streak FROM health_snapshots'

const SAVE_SNAPSHOTS_SQL = `
INSERT INTO health_snapshots (manager_id, score, decline_streak, recorded_at)
SELECT v.manager_id, v.score, v.decline_streak, NOW()
FROM UNNEST($1::text[], $2::integer[], $3::integer[])
     WITH ORDINALITY AS v(manager_id, score, decline_streak, ordinal)
ORDER BY v.ordinal
ON CONFLICT (manager_id) DO UPDATE SET
  score = EXCLUDED.score,
  decline_streak = EXCLUDED.decline_streak,
  recorded_at = NOW()`

const APPEND_HISTORY_SQL = `
INSERT INTO health_score_history (manager_id, score, health_level, recorded_at)
SELECT v.manager_id, v.score, v.health_level, NOW()
FROM UNNEST($1::text[], $2::integer[], $3::text[])
     WITH ORDINALITY AS v(manager_id, score, health_level, ordinal)
WHERE NOT EXISTS (
  SELECT 1 FROM health_score_history h
  WHERE h.manager_id = v.manager_id
    AND h.recorded_at > NOW() - INTERVAL '1 hour'
)
ORDER BY v.ordinal`

const LIST_HISTORY_SQL = `
SELECT manager_id, score, health_level, recorded_at
FROM health_score_history
WHERE manager_id = ANY($1::text[])
  AND recorded_at >= NOW() - ($2::double precision * INTERVAL '1 day')
ORDER BY manager_id, recorded_at ASC`

let tableEnsured = false

async function ensureTable() {
    if (tableEnsured) return
    await prisma.$executeRawUnsafe(ENSURE_TABLE_SQL)
    await prisma.$executeRawUnsafe(ENSURE_COLUMN_SQL)
    await prisma.$executeRawUnsafe(ENSURE_HISTORY_TABLE_SQL)
    await prisma.$executeRawUnsafe(ENSURE_HISTORY_INDEX_SQL)
    tableEnsured = true
}

export const legacyPrismaManagerHealthRepositoryPortV1: ManagerHealthRepositoryPortV1 = {
    async ensure() {
        await ensureTable()
    },

    async listSnapshots() {
        await ensureTable()
        const rows = await prisma.$queryRawUnsafe<Array<{
            manager_id: string
            score: number
            decline_streak: number
        }>>(LIST_SNAPSHOTS_SQL)
        return rows.map((row): ManagerHealthSnapshotV1 => ({
            managerId: row.manager_id,
            score: row.score,
            declineStreak: row.decline_streak,
        }))
    },

    async saveScores(items: ManagerHealthScoreInputV1[]) {
        if (items.length === 0) return
        await ensureTable()

        const managerIds = items.map(item => item.managerId)
        const scores = items.map(item => item.score)
        const declineStreaks = items.map(item => item.declineStreak)
        await prisma.$executeRawUnsafe(SAVE_SNAPSHOTS_SQL, managerIds, scores, declineStreaks)

        try {
            const historyManagerIds = items.map(item => item.managerId)
            const historyScores = items.map(item => item.score)
            const healthLevels = items.map(item => item.healthLevel)
            await prisma.$executeRawUnsafe(APPEND_HISTORY_SQL, historyManagerIds, historyScores, healthLevels)
        } catch (error) {
            console.error('[health-history] Failed to write history, continuing:', error)
        }
    },

    async listHistory(managerIds: string[], periodDays: number) {
        if (managerIds.length === 0) return []
        await ensureTable()
        const rows = await prisma.$queryRawUnsafe<Array<{
            manager_id: string
            score: number
            health_level: string
            recorded_at: Date
        }>>(LIST_HISTORY_SQL, managerIds, periodDays)
        return rows.map((row): ManagerHealthHistoryPointV1 => ({
            managerId: row.manager_id,
            score: row.score,
            healthLevel: row.health_level as ManagerHealthHistoryPointV1['healthLevel'],
            recordedAt: row.recorded_at,
        }))
    },
}

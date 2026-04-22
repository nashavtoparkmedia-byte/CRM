#!/usr/bin/env node
/**
 * Wipe all «Отток» (scenario='churn') tasks from the local DB.
 * Other scenarios (onboarding / care / activation / quality / …) are
 * NOT touched. TaskEvent rows are cascade-deleted by the FK.
 *
 * Usage:
 *   node scripts/cleanup_churn.js           # dry run
 *   node scripts/cleanup_churn.js --apply   # actually delete
 */
/* eslint-disable no-console */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')

async function main() {
    console.log(`[cleanup-churn] mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`)

    const before = await prisma.$queryRawUnsafe(`
        SELECT scenario, COUNT(*)::int AS n
        FROM tasks GROUP BY scenario ORDER BY n DESC`)
    console.log('[cleanup-churn] before:')
    for (const r of before) console.log(`  ${r.scenario ?? '(null)'}: ${r.n}`)

    if (!APPLY) {
        console.log('[cleanup-churn] dry run — no rows deleted. Re-run with --apply to execute.')
        return
    }

    const deleted = await prisma.$executeRawUnsafe(
        `DELETE FROM tasks WHERE scenario = 'churn'`,
    )
    console.log(`[cleanup-churn] deleted ${deleted} churn rows (task_events cascade).`)

    const after = await prisma.$queryRawUnsafe(`
        SELECT scenario, COUNT(*)::int AS n
        FROM tasks GROUP BY scenario ORDER BY n DESC`)
    console.log('[cleanup-churn] after:')
    for (const r of after) console.log(`  ${r.scenario ?? '(null)'}: ${r.n}`)
    console.log('[cleanup-churn] done.')
}

main()
    .catch(err => { console.error(err); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())

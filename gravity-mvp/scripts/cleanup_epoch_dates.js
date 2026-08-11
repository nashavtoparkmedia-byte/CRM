#!/usr/bin/env node
/**
 * One-shot data cleanup: tasks that have Unix-epoch-like timestamps
 * (< 2010-01-01) in nextActionAt / dueAt / slaDeadline get them set
 * to NULL. These are leftovers from an old import/seed that wrote 0
 * where the value was actually unknown.
 *
 * Safe to re-run — idempotent.
 *
 * Usage:
 *   node scripts/cleanup_epoch_dates.js          # dry run (default)
 *   node scripts/cleanup_epoch_dates.js --apply  # actually update
 */
/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')
const { clearEpochTaskDatesV1 } = require('../src/modules/work-management/public/v1/legacy-prisma-task-date-cleanup-adapter')
const prisma = new PrismaClient()
const CUTOFF = new Date('2010-01-01T00:00:00Z')
const APPLY = process.argv.includes('--apply')

async function main() {
    console.log(`[cleanup] mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}   cutoff: ${CUTOFF.toISOString()}`)

    const before = await prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) FILTER (WHERE "nextActionAt" IS NOT NULL AND "nextActionAt" < $1) AS epoch_next,
          COUNT(*) FILTER (WHERE "dueAt"        IS NOT NULL AND "dueAt"        < $1) AS epoch_due,
          COUNT(*) FILTER (WHERE "slaDeadline"  IS NOT NULL AND "slaDeadline"  < $1) AS epoch_sla
        FROM tasks
    `, CUTOFF)
    console.log('[cleanup] before:', before[0])

    if (!APPLY) {
        console.log('[cleanup] dry run — no rows updated. Re-run with --apply to execute.')
        return
    }

    const { nextActionAt, dueAt, slaDeadline } = await clearEpochTaskDatesV1()
    const r1 = nextActionAt
    console.log(`[cleanup] nextActionAt → NULL for ${r1} rows`)
    const r2 = dueAt
    console.log(`[cleanup] dueAt        → NULL for ${r2} rows`)
    const r3 = slaDeadline
    console.log(`[cleanup] slaDeadline  → NULL for ${r3} rows`)

    const after = await prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) FILTER (WHERE "nextActionAt" IS NOT NULL AND "nextActionAt" < $1) AS epoch_next,
          COUNT(*) FILTER (WHERE "dueAt"        IS NOT NULL AND "dueAt"        < $1) AS epoch_due,
          COUNT(*) FILTER (WHERE "slaDeadline"  IS NOT NULL AND "slaDeadline"  < $1) AS epoch_sla
        FROM tasks
    `, CUTOFF)
    console.log('[cleanup] after: ', after[0])
    console.log('[cleanup] done.')
}

main()
    .catch(err => { console.error(err); process.exitCode = 1 })
    .finally(() => prisma.$disconnect())

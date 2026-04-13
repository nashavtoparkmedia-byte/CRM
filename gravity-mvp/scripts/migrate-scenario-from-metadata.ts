/**
 * One-time migration: move metadata.scenario → Task.scenario column.
 * Run after prisma migrate for add_scenario_fields.
 *
 * Usage: npx tsx scripts/migrate-scenario-from-metadata.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
    // Find tasks where metadata contains scenario but column is null
    const tasks = await prisma.task.findMany({
        where: {
            scenario: null,
            metadata: { not: { equals: null } },
        },
        select: { id: true, metadata: true },
    })

    let updated = 0
    let skipped = 0

    for (const task of tasks) {
        const meta = task.metadata as Record<string, any> | null
        const scenario = meta?.scenario
        if (!scenario || scenario === 'contact') {
            skipped++
            continue
        }

        await prisma.task.update({
            where: { id: task.id },
            data: { scenario },
        })
        updated++
    }

    console.log(`Done. Processed ${tasks.length} tasks: ${updated} updated, ${skipped} skipped.`)
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect())

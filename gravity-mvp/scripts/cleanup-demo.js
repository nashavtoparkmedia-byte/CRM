/* eslint-disable @typescript-eslint/no-require-imports */
const { deleteSeededTasksV1 } = require('../src/modules/work-management/public/v1/legacy-prisma-seeded-task-cleanup-adapter')

async function main() {
    // Delete task events for seeded tasks (ids start with 'c')
    const { events: evts, tasks } = await deleteSeededTasksV1()
    console.log(`Deleted ${evts.count} task events`)
    console.log(`Deleted ${tasks.count} tasks`)
}

main().catch(e => { console.error(e); process.exit(1) })

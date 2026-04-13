const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()

async function main() {
    // Delete task events for seeded tasks (ids start with 'c')
    const evts = await p.taskEvent.deleteMany({ where: { taskId: { startsWith: 'c' } } })
    console.log(`Deleted ${evts.count} task events`)

    const tasks = await p.task.deleteMany({ where: { id: { startsWith: 'c' } } })
    console.log(`Deleted ${tasks.count} tasks`)

    await p.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })

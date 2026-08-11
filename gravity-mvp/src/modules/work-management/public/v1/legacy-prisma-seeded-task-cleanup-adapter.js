/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')
async function deleteSeededTasksV1() {
  const prisma = new PrismaClient()
  try {
    const events = await prisma.taskEvent.deleteMany({ where: { taskId: { startsWith: 'c' } } })
    const tasks = await prisma.task.deleteMany({ where: { id: { startsWith: 'c' } } })
    return { events, tasks }
  } finally { await prisma.$disconnect() }
}
module.exports = { deleteSeededTasksV1 }

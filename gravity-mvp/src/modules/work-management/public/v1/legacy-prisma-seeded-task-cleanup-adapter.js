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

/** Work Management-owned exact churn cleanup. */
async function deleteChurnTasksV1() {
  const prisma = new PrismaClient()
  try {
    return await prisma.task.deleteMany({ where: { scenario: 'churn' } })
  } finally { await prisma.$disconnect() }
}

/** Work Management-owned single-task contact backfill. */
async function setTaskContactV1(taskId, contactId) {
  if (typeof taskId !== 'string' || !taskId || typeof contactId !== 'string' || !contactId) throw new TypeError('taskId and contactId are required')
  const prisma = new PrismaClient()
  try {
    return await prisma.task.update({ where: { id: taskId }, data: { contactId } })
  } finally { await prisma.$disconnect() }
}
async function deleteChurnDataV1() {
  const prisma = new PrismaClient(); try { const events = await prisma.taskEvent.deleteMany({ where: { task: { scenario: 'churn' } } }); const tasks = await prisma.task.deleteMany({ where: { scenario: 'churn' } }); return { events, tasks } } finally { await prisma.$disconnect() }
}
async function createImportedChurnTaskV1(data) {
  if (!data || typeof data !== 'object' || data.scenario !== 'churn' || typeof data.driverId !== 'string') throw new TypeError('validated churn task data required')
  const prisma = new PrismaClient(); try { return await prisma.task.create({ data }) } finally { await prisma.$disconnect() }
}
async function createImportedTaskEventsV1(data) {
  if (!Array.isArray(data) || data.some(event => !event || typeof event.taskId !== 'string')) throw new TypeError('validated task events required')
  const prisma = new PrismaClient(); try { return await prisma.taskEvent.createMany({ data }) } finally { await prisma.$disconnect() }
}

module.exports = { deleteSeededTasksV1, deleteChurnTasksV1, setTaskContactV1, deleteChurnDataV1, createImportedChurnTaskV1, createImportedTaskEventsV1 }

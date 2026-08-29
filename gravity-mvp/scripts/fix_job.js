/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require('@prisma/client')
const { completeHistoryImportJobV1 } = require('../src/modules/messaging/public/v1/legacy-prisma-history-import-maintenance-adapter')
const prisma = new PrismaClient()
async function main() {
  const jobId = 'job_1774863276903'
  await completeHistoryImportJobV1(jobId)
  const rows = await prisma.$queryRaw`SELECT id, status, "messagesImported", "chatsScanned" FROM "HistoryImportJob" WHERE id = 'job_1774863276903'`
  console.log('After update:', JSON.stringify(rows, null, 2))
}
main().catch(console.error).finally(() => prisma.$disconnect())

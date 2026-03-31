const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
async function main() {
  const jobId = 'job_1774863276903'
  // Try raw update
  await prisma.$executeRawUnsafe(
    `UPDATE "HistoryImportJob" SET status = 'completed'::"AiImportStatus", "resultType" = 'full', "messagesImported" = 761, "chatsScanned" = 22, "contactsFound" = 23, "finishedAt" = NOW() WHERE id = $1`,
    jobId
  )
  const rows = await prisma.$queryRaw`SELECT id, status, "messagesImported", "chatsScanned" FROM "HistoryImportJob" WHERE id = 'job_1774863276903'`
  console.log('After update:', JSON.stringify(rows, null, 2))
}
main().catch(console.error).finally(() => prisma.$disconnect())

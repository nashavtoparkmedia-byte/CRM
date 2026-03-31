const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
async function main() {
  const rows = await prisma.$queryRaw`SELECT id, status, "messagesImported", "chatsScanned", "contactsFound", "finishedAt" FROM "HistoryImportJob" ORDER BY "createdAt" DESC LIMIT 3`
  console.log(JSON.stringify(rows, null, 2))
}
main().catch(console.error).finally(() => prisma.$disconnect())

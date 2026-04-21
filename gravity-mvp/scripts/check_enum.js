const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
async function main() {
  const rows = await prisma.$queryRaw`SELECT DISTINCT type FROM "Message" WHERE type IS NOT NULL ORDER BY type`
  console.log('Distinct MessageType values in DB:', rows)
  const callCount = await prisma.$queryRaw`SELECT COUNT(*)::int AS c FROM "Message" WHERE type::text = 'call'`
  console.log('Messages with type=call:', callCount[0].c)
}
main().finally(() => prisma.$disconnect())

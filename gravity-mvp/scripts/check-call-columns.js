const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const cols = await prisma.$queryRaw`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'Call'
    ORDER BY ordinal_position
  `
  console.log('Call columns:')
  cols.forEach(c => console.log(`  ${c.column_name}: ${c.data_type}`))
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })

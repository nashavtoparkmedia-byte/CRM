const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  try {
    // Try a simple Call query that uses isAi
    const cnt = await prisma.call.count({ where: { isAi: false } })
    console.log(`Calls with isAi=false: ${cnt}`)

    // Try latest 5 calls
    const latest = await prisma.call.findMany({
      take: 5,
      orderBy: { startedAt: 'desc' },
      select: { id: true, direction: true, status: true, fromNumber: true, toNumber: true, startedAt: true, isAi: true, fsUuid: true },
    })
    console.log('\nLatest 5 calls:')
    latest.forEach(c => console.log(`  ${c.startedAt.toISOString()} ${c.direction} ${c.status} ${c.fromNumber}→${c.toNumber} isAi=${c.isAi} fsUuid=${c.fsUuid?.slice(0,8)}`))
  } catch (e) {
    console.error('Error:', e.message)
  }
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })

const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    // Calls in the last 30 minutes
    const since = new Date(Date.now() - 30 * 60_000)
    const calls = await prisma.call.findMany({
        where: { startedAt: { gte: since } },
        orderBy: { startedAt: 'desc' },
        select: { id: true, direction: true, status: true, fromNumber: true, toNumber: true, durationSec: true, hangupCause: true, contactId: true, fsUuid: true, startedAt: true },
    })
    console.log(`Calls in last 30 min: ${calls.length}`)
    calls.forEach(c => {
        console.log(`  ${c.startedAt.toISOString()} ${c.direction} ${c.status} ${c.fromNumber}→${c.toNumber} dur=${c.durationSec} cause=${c.hangupCause} fsUuid=${c.fsUuid?.slice(0,8)} contactId=${c.contactId}`)
    })
    await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })

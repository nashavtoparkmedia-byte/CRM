const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    const mainIds = ['onboarding', 'churn', 'care']

    // Total active main-scenario tasks
    const total = await prisma.task.count({
        where: { scenario: { in: mainIds }, isActive: true },
    })
    console.log(`Total active main-scenario tasks: ${total}`)

    // Orphans (no driverId)
    const orphan = await prisma.task.findMany({
        where: { driverId: null, scenario: { in: mainIds }, isActive: true },
        select: { id: true, title: true, scenario: true, contactId: true },
        take: 5,
    })
    console.log(`\nOrphan (driverId=null) active main-scenario tasks: ${orphan.length}`)
    orphan.forEach(t => console.log(`  ${t.id} scenario=${t.scenario} contactId=${t.contactId} title="${t.title}"`))

    // Simulate what `prisma.task.findFirst({ where: { driverId: undefined, scenario: { in: mainIds }, isActive: true } })` returns
    const simulated = await prisma.task.findFirst({
        where: { driverId: undefined, scenario: { in: mainIds }, isActive: true },
        select: { id: true, scenario: true, driverId: true, contactId: true, title: true },
    })
    console.log(`\nfindFirst({ driverId: undefined, ... }) returns:`)
    console.log(' ', simulated)

    await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })

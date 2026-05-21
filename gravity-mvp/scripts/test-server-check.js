const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    const contactId = 'cmp8aharg00e6vpr4egzm0e54'  // +79200486360
    const mainIds = ['onboarding', 'churn', 'care']

    // Simulate new server logic with contactId only (no driverId)
    const driverId = undefined
    const targetClause = driverId && contactId
        ? { OR: [{ driverId }, { contactId }] }
        : driverId
            ? { driverId }
            : { contactId }
    
    const existing = await prisma.task.findFirst({
        where: { ...targetClause, scenario: { in: mainIds }, isActive: true },
        select: { id: true, scenario: true, driverId: true, contactId: true, title: true },
    })
    console.log(`New server check for { driverId: undefined, contactId: "${contactId}" }:`)
    console.log(' ', existing || 'null (no conflict — task can be created)')
    
    // Old behavior (broken) — for comparison
    const oldExisting = await prisma.task.findFirst({
        where: { driverId: undefined, scenario: { in: mainIds }, isActive: true },
        select: { id: true, scenario: true, driverId: true, title: true },
    })
    console.log(`\nOld broken behavior (driverId: undefined treated as no filter):`)
    console.log(' ', oldExisting)
    
    await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })

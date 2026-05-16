const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    const contactId = 'cmp8aharg00e6vpr4egzm0e54'
    const mainIds = ['onboarding', 'churn', 'care']
    
    // Test the exact query the server runs
    const t1 = await prisma.task.findFirst({
        where: { driverId: contactId, scenario: { in: mainIds }, isActive: true },
        select: { id: true, scenario: true, driverId: true, contactId: true, title: true },
    })
    console.log(`findFirst with driverId="${contactId}":`)
    console.log(' ', t1)

    // What if a task has contactId = our id and was created with scenario?
    const t2 = await prisma.task.findFirst({
        where: { contactId, scenario: { in: mainIds }, isActive: true },
        select: { id: true, scenario: true, driverId: true, contactId: true, title: true },
    })
    console.log(`\nfindFirst with contactId="${contactId}":`)
    console.log(' ', t2)

    await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })

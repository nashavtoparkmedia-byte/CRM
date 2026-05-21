const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    const drivers = await prisma.driver.findMany({
        where: { phone: { contains: '9200486360' } },
        select: { id: true, fullName: true, phone: true, segment: true },
    })
    console.log(`Drivers with phone ~9200486360: ${drivers.length}`)
    drivers.forEach(d => console.log(`  ${d.id} "${d.fullName}" phone=${d.phone}`))

    const phones = await prisma.contactPhone.findMany({
        where: { phone: { contains: '9200486360' } },
        select: { phone: true, contactId: true, isActive: true, contact: { select: { id: true, displayName: true } } },
    })
    console.log(`\nContactPhones with ~9200486360: ${phones.length}`)
    phones.forEach(p => console.log(`  contactId=${p.contactId} contact.displayName="${p.contact?.displayName}" phone=${p.phone} active=${p.isActive}`))

    const mainScenarios = ['onboarding', 'churn', 'care']

    // Tasks per contact
    for (const p of phones) {
        if (!p.contactId) continue
        const allTasks = await prisma.task.findMany({
            where: { OR: [{ contactId: p.contactId }, { driverId: p.contactId }], isActive: true },
            select: { id: true, title: true, scenario: true, driverId: true, contactId: true, status: true, isActive: true },
        })
        console.log(`\nActive tasks for contact OR driverId=${p.contactId}: ${allTasks.length}`)
        allTasks.forEach(t => console.log(`  ${t.id} scenario=${t.scenario} driverId=${t.driverId} contactId=${t.contactId} title="${t.title}" status=${t.status}`))
    }

    // Sanity: is there a driver whose ID matches the contact ID?
    for (const p of phones) {
        if (!p.contactId) continue
        const d = await prisma.driver.findUnique({ where: { id: p.contactId }, select: { id: true, fullName: true } })
        console.log(`Driver with id=${p.contactId}: ${d ? 'EXISTS: ' + d.fullName : 'none'}`)
    }

    await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })

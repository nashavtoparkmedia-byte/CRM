/**
 * Seed CRM users — run once after migration.
 * Usage: npx tsx scripts/seed-crm-users.ts
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const USERS = [
    { name: 'Менеджер 1', role: 'manager' },
    { name: 'Менеджер 2', role: 'manager' },
    { name: 'Руководитель', role: 'lead' },
]

async function main() {
    for (const user of USERS) {
        const existing = await prisma.crmUser.findFirst({
            where: { name: user.name },
        })
        if (existing) {
            console.log(`  skip: "${user.name}" already exists`)
            continue
        }
        const created = await prisma.crmUser.create({ data: user })
        console.log(`  created: "${created.name}" (${created.id})`)
    }

    const total = await prisma.crmUser.count()
    console.log(`Done. Total CRM users: ${total}`)
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect())

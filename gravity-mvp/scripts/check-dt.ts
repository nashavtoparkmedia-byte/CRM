import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
    const d = await prisma.driver.findFirst({
        where: { phone: { contains: '9222155750' } },
        include: { telegrams: true }
    })
    console.log("Driver and Telegrams:", JSON.stringify(d, null, 2))
}
main().catch(console.error).finally(() => prisma.$disconnect())

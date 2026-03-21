import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
    const conns = await prisma.whatsAppConnection.findMany({
        select: { id: true, name: true, phoneNumber: true, status: true }
    })
    console.log(JSON.stringify(conns, null, 2))
}
main().catch(console.error).finally(() => prisma.$disconnect())

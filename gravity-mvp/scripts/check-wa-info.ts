import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
async function main() {
    console.log(await prisma.whatsAppConnection.findMany({ select: { id: true, name: true, phoneNumber: true, status: true}}))
}
main().then(() => prisma.$disconnect()).catch(console.error)

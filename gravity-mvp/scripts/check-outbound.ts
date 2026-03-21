import { PrismaClient } from '@prisma/client'
import * as fs from 'fs'

const prisma = new PrismaClient()

async function main() {
    const messages = await prisma.message.findMany({
        where: {
            direction: 'outbound',
        },
        orderBy: {
            createdAt: 'desc'
        },
        take: 20,
        include: {
            chat: true
        }
    })

    fs.writeFileSync('outbound.json', JSON.stringify(messages, null, 2))
    console.log('Wrote to outbound.json')
}

main().catch(console.error).finally(() => prisma.$disconnect())

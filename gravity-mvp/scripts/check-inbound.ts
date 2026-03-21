import { PrismaClient } from '@prisma/client'
import fs from 'fs'

const prisma = new PrismaClient()

async function main() {
    const msgs = await (prisma as any).message.findMany({
        where: { direction: 'inbound' },
        orderBy: { sentAt: 'desc' },
        take: 10,
        include: { chat: true }
    })
    fs.writeFileSync('scripts/out.json', JSON.stringify(msgs, null, 2))
}

main().catch(console.error).finally(() => prisma.$disconnect())

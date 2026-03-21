import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
    console.log("Checking for duplicate messages...")
    
    const messages = await prisma.message.findMany({
        orderBy: { sentAt: 'desc' },
        take: 100
    })

    const seen = new Set()
    const duplicates = []

    for (const msg of messages) {
        // Simple heuristic for duplication: same content, same chatId, same direction, within 5 seconds
        const key = `${msg.chatId}:${msg.direction}:${msg.content}`
        const timestamp = new Date(msg.sentAt).getTime()
        
        const possibleDuplicate = messages.find(m => 
            m.id !== msg.id &&
            m.chatId === msg.chatId &&
            m.direction === msg.direction &&
            m.content === msg.content &&
            Math.abs(new Date(m.sentAt).getTime() - timestamp) < 5000
        )

        if (possibleDuplicate && !seen.has(msg.id) && !seen.has(possibleDuplicate.id)) {
            duplicates.push({
                msg1: { id: msg.id, content: msg.content, sentAt: msg.sentAt, externalId: msg.externalId },
                msg2: { id: possibleDuplicate.id, content: possibleDuplicate.content, sentAt: possibleDuplicate.sentAt, externalId: possibleDuplicate.externalId }
            })
            seen.add(msg.id)
            seen.add(possibleDuplicate.id)
        }
    }

    console.log(`Found ${duplicates.length} potential duplicate pairs in last 100 messages.`)
    console.log(JSON.stringify(duplicates, null, 2))
}

main().catch(console.error).finally(() => prisma.$disconnect())

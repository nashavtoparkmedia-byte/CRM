/**
 * Одноразовая чистка: убрать a11y-префикс "Окно чата с " у MAX-чатов,
 * сохранённый предыдущей версией NameSync до фикса prefix-strip.
 */
const { PrismaClient } = require('@prisma/client')
const { stripMaxChatPrefixV1 } = require('../src/modules/messaging/public/v1/legacy-prisma-chat-name-maintenance-adapter')
const { restoreContactDisplayNameIfPrefixedV1 } = require('../src/modules/contacts/public/v1/legacy-prisma-contact-name-maintenance-adapter')
const prisma = new PrismaClient()

async function main() {
    const chats = await prisma.chat.findMany({
        where: { channel: 'max', name: { startsWith: 'Окно чата с' } },
        select: { id: true, name: true, contactId: true },
    })
    console.log(`Found ${chats.length} chats with a11y prefix`)

    let updated = 0
    for (const c of chats) {
        const m = c.name.match(/^Окно чата с\s+(.+)$/i)
        if (!m) continue
        const cleaned = m[1].trim()
        if (!cleaned) continue
        await stripMaxChatPrefixV1(c.id, cleaned)
        if (c.contactId) {
            await restoreContactDisplayNameIfPrefixedV1(c.contactId, cleaned)
        }
        console.log(`  ${c.id}: "${c.name}" → "${cleaned}"`)
        updated++
    }
    await prisma.$disconnect()
    console.log(`Done. updated=${updated}`)
}
main().catch(e => { console.error(e); process.exit(1) })

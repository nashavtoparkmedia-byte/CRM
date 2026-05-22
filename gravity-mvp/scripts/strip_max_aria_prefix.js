/**
 * Одноразовая чистка: убрать a11y-префикс "Окно чата с " у MAX-чатов,
 * сохранённый предыдущей версией NameSync до фикса prefix-strip.
 */
const { PrismaClient } = require('@prisma/client')
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
        await prisma.chat.update({ where: { id: c.id }, data: { name: cleaned } })
        if (c.contactId) {
            const contact = await prisma.contact.findUnique({ where: { id: c.contactId }, select: { displayName: true } })
            if (contact && /^Окно чата с/i.test(contact.displayName || '')) {
                await prisma.contact.update({ where: { id: c.contactId }, data: { displayName: cleaned } })
            }
        }
        console.log(`  ${c.id}: "${c.name}" → "${cleaned}"`)
        updated++
    }
    await prisma.$disconnect()
    console.log(`Done. updated=${updated}`)
}
main().catch(e => { console.error(e); process.exit(1) })

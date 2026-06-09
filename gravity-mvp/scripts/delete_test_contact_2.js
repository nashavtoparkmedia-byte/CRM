// One-off: удалить тестовую Карточку 2 (Ремезов Саша, +73082482905)
// Cascade: chat → Message + MessageAttachment + GroupVisibility,
//          contact → ContactPhone + ContactIdentity

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const CHAT_ID = 'cmoe4p1ak0003vpt8vhfos96u'
const CONTACT_ID = 'cmpirot8w00hevpp09w45twmv'

async function main() {
    console.log('Pre-check...')
    const chat = await prisma.chat.findUnique({
        where: { id: CHAT_ID },
        select: { id: true, name: true, channel: true, externalChatId: true }
    })
    const contact = await prisma.contact.findUnique({
        where: { id: CONTACT_ID },
        select: { id: true, displayName: true }
    })
    console.log('  chat:', chat)
    console.log('  contact:', contact)
    if (!chat && !contact) {
        console.log('Уже удалены — выход.')
        return
    }

    const msgCount = await prisma.message.count({ where: { chatId: CHAT_ID } })
    console.log(`  messages в чате: ${msgCount}`)

    if (chat) {
        console.log('Удаляем Chat (cascade → Message + MessageAttachment + GroupVisibility)...')
        const r = await prisma.chat.delete({ where: { id: CHAT_ID } })
        console.log('  Chat deleted:', r.id, r.name)
    }

    if (contact) {
        console.log('Удаляем Contact (cascade → ContactPhone + ContactIdentity)...')
        const r = await prisma.contact.delete({ where: { id: CONTACT_ID } })
        console.log('  Contact deleted:', r.id, r.displayName)
    }

    console.log('Post-check...')
    const chat2 = await prisma.chat.findUnique({ where: { id: CHAT_ID } })
    const contact2 = await prisma.contact.findUnique({ where: { id: CONTACT_ID } })
    const msg2 = await prisma.message.count({ where: { chatId: CHAT_ID } })
    console.log('  chat exists:', !!chat2)
    console.log('  contact exists:', !!contact2)
    console.log('  messages remaining:', msg2)
    console.log('Done!')
}

main()
    .catch(e => { console.error('ERR:', e); process.exit(1) })
    .finally(() => prisma.$disconnect())

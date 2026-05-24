// Cleanup phantom-phone artefacts для «Меграбян Гегам».
// Тот же сценарий что Исаков, но дополнительно нужно слить два WA-чата:
//   - chat_A (cmpgm9kt800g0vpc0h807vgb7): фантомный externalChatId 'whatsapp:72038910130',
//     но активный — 15 сообщений, driverId привязан, status=open.
//   - chat_B (cmpjak25e000bvpf05myukjj6): правильный @lid externalChatId '253292038910130@lid',
//     3 сообщения, без driverId, status=new.
//
// Без слияния chat'ов следующий inbound по @lid (с моим fix не resolving в @c.us) попадёт
// в новый chat, а старый с 15 сообщениями станет orphan. Поэтому:
//   1. Migrate 3 сообщения из chat_B в chat_A.
//   2. Delete chat_B (он пуст).
//   3. UPDATE chat_A.externalChatId = '253292038910130@lid' (правильный @lid).
//   4. Repoint @lid identity к настоящему phone +79996000939.
//   5. Deactivate dead @c.us identity (72038910130) — фантом.
//   6. Soft-delete phantom phone +72038910130 (отдельным curl после скрипта).
//
// Запуск: node gravity-mvp/scripts/cleanup_megrabyan_phantom.js

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const CHAT_A_ID         = 'cmpgm9kt800g0vpc0h807vgb7'   // активный chat (фантомный externalChatId)
const CHAT_B_ID         = 'cmpjak25e000bvpf05myukjj6'   // правильный @lid, 3 сообщения
const CORRECT_LID_EXT   = '253292038910130@lid'
const REAL_PHONE_ID     = 'cmnjf1h8n09sjvp080h2z4pmm'   // +79996000939 (source=yandex)
const LID_IDENTITY_ID   = 'cmpgm9ku500g5vpc0p9f4a5l1'   // externalId 253292038910130
const CUS_IDENTITY_ID   = 'cmping75o000xvpp055983rua'   // externalId 72038910130 (dead phantom @c.us)

async function main() {
    console.log('[megrabyan-cleanup] start')

    await prisma.$transaction(async (tx) => {
        // 1. Migrate сообщения chat_B → chat_A
        const migrated = await tx.message.updateMany({
            where: { chatId: CHAT_B_ID },
            data:  { chatId: CHAT_A_ID },
        })
        console.log(`[megrabyan-cleanup] (1) migrated ${migrated.count} messages B→A`)

        // 2. Delete WhatsAppMessage rows by chatId B too (если они есть в legacy table)
        //    — потому что chatId там тоже может ссылаться. Пропустим, если table не используется
        //    этой моделью. Безопасно: если ничего не найдётся, deleteMany молча вернёт 0.

        // 3. Чтобы избежать unique constraint конфликта на externalChatId при rename,
        //    сначала освобождаем правильный @lid externalChatId — переименуем chat_B
        //    в временный, потом удалим. (chat_B сейчас держит CORRECT_LID_EXT.)
        await tx.chat.update({
            where: { id: CHAT_B_ID },
            data:  { externalChatId: `__deleted_${CHAT_B_ID}` },
        })
        console.log(`[megrabyan-cleanup] (2) chat_B externalChatId перенесён в tombstone`)

        // 4. Delete chat_B
        await tx.chat.delete({ where: { id: CHAT_B_ID } })
        console.log(`[megrabyan-cleanup] (3) chat_B deleted`)

        // 5. Rename chat_A externalChatId в правильный @lid
        await tx.chat.update({
            where: { id: CHAT_A_ID },
            data:  { externalChatId: CORRECT_LID_EXT },
        })
        console.log(`[megrabyan-cleanup] (4) chat_A externalChatId → ${CORRECT_LID_EXT}`)

        // 6. Repoint @lid identity к настоящему phone
        await tx.contactIdentity.update({
            where: { id: LID_IDENTITY_ID },
            data:  { phoneId: REAL_PHONE_ID },
        })
        console.log(`[megrabyan-cleanup] (5) @lid identity repointed к phone ${REAL_PHONE_ID}`)

        // 7. Deactivate dead @c.us identity
        await tx.contactIdentity.update({
            where: { id: CUS_IDENTITY_ID },
            data:  { isActive: false, phoneId: null },
        })
        console.log(`[megrabyan-cleanup] (6) @c.us identity deactivated`)
    })

    console.log('[megrabyan-cleanup] DONE — теперь curl DELETE phantom phone /api/contacts/.../phones/...')
    await prisma.$disconnect()
}

main().catch(err => {
    console.error('[megrabyan-cleanup] FAILED:', err)
    process.exit(1)
})

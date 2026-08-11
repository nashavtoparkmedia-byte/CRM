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

/* eslint-disable @typescript-eslint/no-require-imports */
const { cleanupMegrabyanChatsV1 } = require('../src/modules/messaging/public/v1/legacy-prisma-megrabyan-chat-cleanup-adapter')
const { cleanupMegrabyanIdentitiesV1 } = require('../src/modules/contacts/public/v1/legacy-prisma-megrabyan-identity-cleanup-adapter')

async function main() {
    console.log('[megrabyan-cleanup] start')
    const { migrated } = await cleanupMegrabyanChatsV1()
        console.log(`[megrabyan-cleanup] (1) migrated ${migrated.count} messages B→A`)
    await cleanupMegrabyanIdentitiesV1()

    console.log('[megrabyan-cleanup] DONE — теперь curl DELETE phantom phone /api/contacts/.../phones/...')
}

main().catch(err => {
    console.error('[megrabyan-cleanup] FAILED:', err)
    process.exit(1)
})

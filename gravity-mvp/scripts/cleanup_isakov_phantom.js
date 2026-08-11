// Cleanup phantom-phone artefacts оставшиеся после merge dupe Исакова Алексея.
// Контекст: дубль Contact B (phone +70945844415, извлечённый системой из @lid)
// был merged в Contact A (phone +79221127866, привязан к Driver). Ниже доводим
// до нормального состояния:
//
//   1. WA @lid identity (124360945844415) — перевязать к настоящему phone A
//   2. WA @c.us identity (70945844415) — deactivate, оторвать от phone
//   3. Старый WA chat (whatsapp:70945844415) — пометить resolved
//   4. (отдельно через API) soft-delete фантом phone +70945844415
//
// Запуск: node gravity-mvp/scripts/cleanup_isakov_phantom.js

/* eslint-disable @typescript-eslint/no-require-imports */
const { cleanupIsakovPhantomV1 } = require('../src/modules/operations/public/v1/legacy-prisma-isakov-phantom-cleanup-adapter')

async function main() {
    console.log('[cleanup] start contactId=cmnjf14sc01cxvp08klpvpz5d')
    await cleanupIsakovPhantomV1()

    console.log('[cleanup] DONE — теперь нужно soft-delete фантом phone через DELETE /api/contacts/.../phones/...')
}

main().catch(err => {
    console.error('[cleanup] FAILED:', err)
    process.exit(1)
})

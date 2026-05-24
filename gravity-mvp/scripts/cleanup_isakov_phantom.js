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

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const REAL_PHONE_ID    = 'cmnjf14sf01czvp08cb2qagcz'   // +79221127866 (source=yandex)
const LID_IDENTITY_ID  = 'cmphc72s3000hvpsksmgk55jr'   // WA externalId 124360945844415
const CUS_IDENTITY_ID  = 'cmph1e54l00ftvpm4ia9xlrvn'   // WA externalId 70945844415 (dead @c.us)
const LEGACY_CHAT_ID   = 'cmph1e53500fovpm430zke5me'   // whatsapp:70945844415

async function main() {
    console.log('[cleanup] start contactId=cmnjf14sc01cxvp08klpvpz5d')

    await prisma.$transaction(async (tx) => {
        const r1 = await tx.contactIdentity.update({
            where: { id: LID_IDENTITY_ID },
            data:  { phoneId: REAL_PHONE_ID },
        })
        console.log(`[cleanup] (1) WA @lid identity ${r1.id} repointed to phone ${REAL_PHONE_ID}`)

        const r2 = await tx.contactIdentity.update({
            where: { id: CUS_IDENTITY_ID },
            data:  { isActive: false, phoneId: null },
        })
        console.log(`[cleanup] (2) WA @c.us identity ${r2.id} deactivated`)

        const r3 = await tx.chat.update({
            where: { id: LEGACY_CHAT_ID },
            data:  { status: 'resolved' },
        })
        console.log(`[cleanup] (3) Legacy WA chat ${r3.id} → status=resolved`)
    })

    console.log('[cleanup] DONE — теперь нужно soft-delete фантом phone через DELETE /api/contacts/.../phones/...')
    await prisma.$disconnect()
}

main().catch(err => {
    console.error('[cleanup] FAILED:', err)
    process.exit(1)
})

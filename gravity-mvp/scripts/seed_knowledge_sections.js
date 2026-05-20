/* eslint-disable no-console */
/**
 * Seed: 10 секций AI Knowledge Core (book-style оглавление).
 *
 * Slug стабильный (используется в URL, навигации, миграции legacy KB
 * в PR5). Title редактируется админом — поэтому upsert обновляет только
 * iconKey/sortOrder/description при create; существующие title не
 * затирает (читай: безопасно запускать многократно).
 *
 * iconKey — имя lucide-react иконки. UI рендерит через словарь в
 * AiControlCenterClient.
 *
 * Использует $executeRaw / $queryRaw напрямую, чтобы не зависеть от
 * свежесгенерированного Prisma client'а (на Windows prisma generate
 * может упасть из-за file-lock'а на query_engine.dll, если dev-сервер
 * удерживает движок).
 *
 * Запуск: cd D:/Github/CRM/gravity-mvp && node scripts/seed_knowledge_sections.js
 */

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const SECTIONS = [
    { slug: 'tariffs',      title: 'Тарифы',                       description: 'Стоимость подключения, комиссия парка, варианты оплаты.',                                                  iconKey: 'Wallet',          sortOrder: 10 },
    { slug: 'requirements', title: 'Требования к водителю',         description: 'Возраст, стаж, гражданство, регион, тип авто.',                                                            iconKey: 'CheckCircle2',    sortOrder: 20 },
    { slug: 'documents',    title: 'Документы',                     description: 'ВУ, СТС, медсправка, ИП/самозанятость, лицензия такси.',                                                   iconKey: 'FileText',        sortOrder: 30 },
    { slug: 'deposit',      title: 'Депозит',                       description: 'Условия залога: когда взимается, как возвращается.',                                                       iconKey: 'PiggyBank',       sortOrder: 40 },
    { slug: 'schedule',     title: 'График работы',                 description: 'Часы выхода на линию, выходные, переключение тарифа в сутки.',                                             iconKey: 'Clock',           sortOrder: 50 },
    { slug: 'payouts',      title: 'Выплаты',                       description: 'Моментальные выплаты, период начислений, бонусы.',                                                         iconKey: 'Banknote',        sortOrder: 60 },
    { slug: 'faq',          title: 'Частые вопросы',                description: 'Типовые быстрые ответы на повторяющиеся запросы.',                                                          iconKey: 'MessageCircle',   sortOrder: 70 },
    { slug: 'objections',   title: 'Возражения',                    description: 'Типовые сомнения водителя и ответы на них.',                                                                iconKey: 'AlertTriangle',   sortOrder: 80 },
    { slug: 'promises',     title: 'Что AI может обещать',          description: 'Утверждения, которые AI вправе делать без эскалации.',                                                      iconKey: 'CheckSquare',     sortOrder: 90 },
    { slug: 'restrictions', title: 'Что AI не должен обещать',      description: 'Утверждения, которые требуют участия менеджера или запрещены.',                                             iconKey: 'Ban',             sortOrder: 100 },
]

async function main() {
    console.log('[seed-knowledge-sections] Connecting...')
    await prisma.$queryRaw`SELECT 1`
    console.log('[seed-knowledge-sections] DB OK. Seeding 10 sections...')

    let created = 0, updated = 0
    for (const s of SECTIONS) {
        const existing = await prisma.$queryRaw`
            SELECT id FROM "AiKnowledgeSection" WHERE slug = ${s.slug} LIMIT 1
        `
        if (existing.length === 0) {
            const id = 'sec_' + s.slug + '_' + Date.now()
            await prisma.$executeRaw`
                INSERT INTO "AiKnowledgeSection"
                    (id, slug, title, description, "iconKey", "sortOrder", "isActive", "createdAt", "updatedAt")
                VALUES
                    (${id}, ${s.slug}, ${s.title}, ${s.description},
                     ${s.iconKey}, ${s.sortOrder}, true, NOW(), NOW())
            `
            created++
            console.log(`  + created   ${s.slug} (${s.title})`)
        } else {
            await prisma.$executeRaw`
                UPDATE "AiKnowledgeSection"
                SET description = ${s.description},
                    "iconKey"   = ${s.iconKey},
                    "sortOrder" = ${s.sortOrder},
                    "updatedAt" = NOW()
                WHERE slug = ${s.slug}
            `
            updated++
            console.log(`  ↻ updated   ${s.slug} (${s.title})`)
        }
    }

    console.log(`[seed-knowledge-sections] Done. created=${created} updated=${updated}`)
}

main()
    .catch(e => { console.error('[seed-knowledge-sections] FAILED:', e); process.exit(1) })
    .finally(async () => { await prisma.$disconnect() })

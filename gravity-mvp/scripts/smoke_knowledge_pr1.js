/* eslint-disable no-console */
/**
 * Smoke test для PR1 AI Knowledge Core.
 *
 * Проверяет, что страница /settings/ai отвечает 200 и в SSR-HTML
 * присутствует новая вкладка "Ядро знаний", все 10 секций и их
 * описания. Не открывает браузер, просто HTTP GET с админским cookie.
 *
 * Запуск: cd D:/Github/CRM/gravity-mvp && node scripts/smoke_knowledge_pr1.js
 */

const BASE = process.env.CRM_BASE_URL || 'http://localhost:3002'
// u3 — Руководитель (см. src/data/users.json), имеет canEdit=true.
const ADMIN_COOKIE = 'crm_user_id=u3'

const EXPECTED_TAB_LABEL = 'Ядро знаний'
const EXPECTED_SECTIONS = [
    'Тарифы', 'Требования к водителю', 'Документы', 'Депозит',
    'График работы', 'Выплаты', 'Частые вопросы', 'Возражения',
    'Что AI может обещать', 'Что AI не должен обещать',
]

async function main() {
    console.log(`[smoke] GET ${BASE}/settings/ai ...`)
    const res = await fetch(`${BASE}/settings/ai`, {
        headers: { Cookie: ADMIN_COOKIE },
        redirect: 'manual',
    })

    console.log(`[smoke] status=${res.status}`)
    if (res.status !== 200) {
        console.error(`[smoke] FAIL — expected 200, got ${res.status}`)
        process.exit(1)
    }

    const html = await res.text()
    console.log(`[smoke] html length=${html.length}`)

    const checks = [
        { name: 'Tab label "Ядро знаний"',  found: html.includes(EXPECTED_TAB_LABEL) },
        ...EXPECTED_SECTIONS.map(s => ({
            name:  `Section title "${s}"`,
            found: html.includes(s),
        })),
        { name: 'Legacy "База знаний" tab still present', found: html.includes('База знаний') },
        { name: 'No React error boundary',  found: !html.includes('Application error: a server-side exception') },
    ]

    let pass = 0, fail = 0
    for (const c of checks) {
        if (c.found) {
            console.log(`  ✓ ${c.name}`)
            pass++
        } else {
            console.log(`  ✗ ${c.name}`)
            fail++
        }
    }

    console.log(`[smoke] Done. pass=${pass} fail=${fail}`)
    if (fail > 0) process.exit(1)
}

main().catch(e => {
    console.error('[smoke] FAILED:', e.message)
    process.exit(1)
})

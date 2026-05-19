/* eslint-disable no-console */

/**
 * Smoke-check для assertCanEditAi() из gravity-mvp/src/app/settings/ai/actions.ts.
 *
 * Симулирует логику guard-функции без поднятия Next.js dev-server'а.
 * Читает реальный users.json, прогоняет 4 сценария:
 *   1. cookie = u1 (Менеджер)       → должно бросить
 *   2. cookie = u2 (Администратор)  → должно пройти
 *   3. cookie = u3 (Руководитель)   → должно пройти
 *   4. cookie отсутствует           → должно бросить
 *
 * Запуск: node scripts/test_ai_role_guard.js
 */

const fs = require('fs')
const path = require('path')

const usersPath = path.join(__dirname, '..', 'gravity-mvp', 'src', 'data', 'users.json')
const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'))

// Точная копия guard-логики из actions.ts (без вызова Next.js cookies()).
// Принимаем cookieValue как параметр — он симулирует .get('crm_user_id')?.value.
function assertCanEditAi(cookieValue) {
    if (!cookieValue) throw new Error('Недостаточно прав')
    const user = users.find(u => u.id === cookieValue)
    if (!user) throw new Error('Недостаточно прав')
    if (user.role !== 'Администратор' && user.role !== 'Руководитель') {
        throw new Error('Недостаточно прав')
    }
}

function runCase(label, cookie, expectThrow) {
    let threw = false
    let msg = ''
    try {
        assertCanEditAi(cookie)
    } catch (e) {
        threw = true
        msg = e.message
    }
    const passed = threw === expectThrow
    const tag = passed ? 'PASS' : 'FAIL'
    console.log(`[${tag}] ${label.padEnd(40)} cookie=${String(cookie).padEnd(10)} threw=${threw} ${msg ? '("' + msg + '")' : ''}`)
    return passed
}

console.log('--- Smoke-check assertCanEditAi() ---')
console.log('users.json roles:')
for (const u of users) console.log(`  ${u.id} = ${u.role}`)
console.log('')

const results = [
    runCase('Менеджер  → должен быть отклонён',     'u1',         true),
    runCase('Администратор → должен пройти',        'u2',         false),
    runCase('Руководитель → должен пройти',         'u3',         false),
    runCase('Без cookie → должен быть отклонён',    undefined,    true),
    runCase('Пустая cookie → должен быть отклонён', '',           true),
    runCase('Несуществующий id → отклонён',         'u999',       true),
    runCase('Попытка inject — string',              'undefined',  true),
]

const allPassed = results.every(Boolean)
console.log('')
console.log(allPassed ? '✅ Все кейсы прошли.' : '❌ Часть кейсов упала — смотри FAIL выше.')
process.exit(allPassed ? 0 : 1)

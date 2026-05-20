/* eslint-disable no-console */
/**
 * Smoke test для PII-маскинга в src/lib/ai/knowledge/textUtils.ts.
 *
 * Реальные русские кейсы — то, что чаще всего встречается в переписках
 * водителей с менеджерами таксопарка. Если маскинг здесь сломается,
 * PII утечёт в AiKnowledgeSource.excerpt и потом в "Почему AI так
 * ответил?" UI — это privacy incident.
 *
 * Запуск без БД — pure unit-test для regex'ов textUtils. Если правишь
 * textUtils.maskPII — синхронизуй копию ниже.
 *
 * Запуск: cd D:/Github/CRM/gravity-mvp && node scripts/smoke_pii_check.js
 */

// Точная копия regex-логики из src/lib/ai/knowledge/textUtils.ts maskPII().
function maskPII(text) {
    if (!text) return ''
    let out = text
    out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    out = out.replace(/\b(?:https?|ftp):\/\/\S+/gi, '[ссылка]')
    out = out.replace(/\b\d{2}[\s-]\d{2}[\s-]\d{6}\b/g, '[ву]')
    out = out.replace(
        /(?:\+7|8)[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/g,
        '[телефон]'
    )
    out = out.replace(/\b\d{10,}\b/g, '[номер]')
    out = out.replace(/(\[(?:телефон|email|ссылка|ву|номер)\])\1+/g, '$1')
    return out
}

const CASES = [
    // ─── Телефоны ────────────────────────────────────────────────
    {
        name:   'phone +7 with dashes',
        input:  'Звоните +7-900-123-45-67 или 8 900 123 45 67',
        expect: ['[телефон]'],
        forbid: ['+7', '900', '8 900'],
    },
    {
        name:   'phone +7 with parens',
        input:  'Связь через +7(900)123-45-67',
        expect: ['[телефон]'],
        forbid: ['+7(900)', '123-45-67'],
    },
    {
        name:   'phone 8 без скобок',
        input:  'Мой 89001234567',
        expect: ['[телефон]'],
        forbid: ['89001234567'],
    },
    {
        name:   'phone 8 со скобками',
        input:  '8 (900) 123-45-67 — звони',
        expect: ['[телефон]'],
        forbid: ['8 (900)', '900'],
    },

    // ─── Email ───────────────────────────────────────────────────
    {
        name:   'email simple',
        input:  'Пиши на ivan@yandex.ru',
        expect: ['[email]'],
        forbid: ['ivan@', 'yandex.ru'],
    },
    {
        name:   'email с подчёркиванием',
        input:  'driver_ivan.21@mail.ru или test+spam@gmail.com',
        expect: ['[email]'],
        forbid: ['driver_ivan', 'gmail.com'],
    },

    // ─── URL ─────────────────────────────────────────────────────
    {
        name:   'url https',
        input:  'Регистрация: https://taxopark.ru/signup?ref=abc',
        expect: ['[ссылка]'],
        forbid: ['https://', 'taxopark.ru', 'ref=abc'],
    },
    {
        name:   'url http',
        input:  'См. http://example.com/page',
        expect: ['[ссылка]'],
        forbid: ['http://', 'example.com'],
    },

    // ─── ВУ номера ───────────────────────────────────────────────
    {
        name:   'ВУ с пробелами',
        input:  'Серия 77 06 123456 — реквизиты',
        expect: ['[ву]'],
        forbid: ['77 06 123456'],
    },
    {
        // Слитное 10-значное → [номер] (по дизайну).
        name:   'ВУ слитно → [номер]',
        input:  'Номер ВУ 7706123456 проверен',
        expect: ['[номер]'],
        forbid: ['7706123456'],
    },

    // ─── Длинные id ──────────────────────────────────────────────
    {
        name:   'банковская карта 16 цифр',
        input:  'Карта 4276123412341234 для перевода',
        expect: ['[номер]'],
        forbid: ['4276123412341234'],
    },
    {
        name:   'паспорт-подобный 10+ digit ID',
        input:  'ID 1234567890 в системе',
        expect: ['[номер]'],
        forbid: ['1234567890'],
    },

    // ─── Mixed real-world ────────────────────────────────────────
    {
        name:   'mixed: phone + email + url',
        input:  'Звони +7 900 123-45-67, пиши на ivan@example.com, регистрация на https://signup.ru',
        expect: ['[телефон]', '[email]', '[ссылка]'],
        forbid: ['+7', '900', '@', 'https://'],
    },

    // ─── Должны ОСТАТЬСЯ ─────────────────────────────────────────
    {
        name:   'тарифы 3.99% не маскируются',
        input:  'Комиссия парка 3.99% или 8 рублей',
        expect: ['3.99%', '8 рублей'],
        forbid: ['[номер]', '[телефон]'],
    },
    {
        name:   'короткие числа (стаж 3 года) остаются',
        input:  'Стаж от 3 лет, возраст 21 год',
        expect: ['3', '21'],
        forbid: ['[номер]'],
    },
    {
        name:   '14 дней без комиссии — не маскируется',
        input:  'Первые 14 дней без комиссии',
        expect: ['14 дней'],
        forbid: ['[номер]'],
    },
]

let pass = 0, fail = 0
for (const c of CASES) {
    const out = maskPII(c.input)
    const missing = c.expect.filter(t => !out.includes(t))
    const present = (c.forbid || []).filter(t => out.includes(t))
    if (missing.length === 0 && present.length === 0) {
        console.log(`  ✓ ${c.name}`)
        pass++
    } else {
        console.log(`  ✗ ${c.name}`)
        console.log(`      in:  ${c.input}`)
        console.log(`      out: ${out}`)
        if (missing.length) console.log(`      missing: ${JSON.stringify(missing)}`)
        if (present.length) console.log(`      leaked:  ${JSON.stringify(present)}`)
        fail++
    }
}

console.log(`\n[smoke-pii] Done. pass=${pass} fail=${fail} of ${CASES.length}`)
if (fail > 0) process.exit(1)

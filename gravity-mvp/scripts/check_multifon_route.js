/**
 * Проверяет и переключает маршрутизацию МультиФон.
 * API возвращает XML, маршруты: 0=GSM, 1=SIP, 2=SIP+GSM
 */

const https = require('https')

const phone = process.env.MULTIFON_PHONE
const password = process.env.MULTIFON_PASSWORD

if (!phone || !password) {
    console.error('ERROR: Нужны MULTIFON_PHONE и MULTIFON_PASSWORD')
    process.exit(1)
}

const ROUTE_LABELS = { '0': 'GSM (только SIM)', '1': 'SIP (только SIP)', '2': 'SIP+GSM (форкинг)' }

function apiGet(path, extraParams = '') {
    return new Promise((resolve, reject) => {
        const url = `https://sm.megafon.ru/sm/client/${path}?login=${encodeURIComponent(phone)}&password=${encodeURIComponent(password)}${extraParams}`
        https.get(url, (res) => {
            let data = ''
            res.on('data', c => data += c)
            res.on('end', () => resolve({ status: res.statusCode, body: data.trim() }))
        }).on('error', reject)
    })
}

function parseXmlTag(xml, tag) {
    const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)
    return m ? m[1].trim() : null
}

;(async () => {
    console.log(`\n=== МультиФон маршрутизация для ${phone} ===\n`)

    const { status, body } = await apiGet('routing')
    console.log(`HTTP ${status}`)

    const code = parseXmlTag(body, 'code')
    const desc = parseXmlTag(body, 'description')
    const route = parseXmlTag(body, 'routing')

    if (status !== 200 || code !== '200') {
        console.error(`ОШИБКА: ${code} ${desc}`)
        console.error('Возможно неверный пароль МультиФон.')
        process.exit(1)
    }

    const label = ROUTE_LABELS[route] ?? `неизвестно (${route})`
    console.log(`Текущий маршрут: ${route} — ${label}`)

    if (route === '2') {
        console.log('✅ SIP+GSM уже активен. INVITE приходит на FreeSWITCH.')
        return
    }

    console.log(`⚠️  Форкинг выключен. Меняю на 2 (SIP+GSM)...`)

    const result = await apiGet('routing', '&routing=2')
    const rCode = parseXmlTag(result.body, 'code')
    const rDesc = parseXmlTag(result.body, 'description')

    if (rCode === '200') {
        console.log(`✅ Маршрут изменён! ${rDesc}`)
        console.log('   Позвони на 79221853150 — INVITE теперь должен приходить на FreeSWITCH.')
    } else {
        console.error(`❌ Ошибка: ${rCode} ${rDesc}`)
        console.error(result.body)
    }
})()

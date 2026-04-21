// Импорт данных оттока из Excel "CRM парка для GPT.xlsx" -> вкладка "Отток Март 2026"
// В раздел задач CRM (scenario = 'churn')

const { PrismaClient } = require('@prisma/client')
const XLSX = require('xlsx')
const path = require('path')

const prisma = new PrismaClient()

const EXCEL_PATH = path.join('C:\\Users\\mixx\\Downloads', 'CRM парка для GPT.xlsx')
const SHEET_NAME = 'Отток Март 2026'

// Маппинг приоритетов Excel -> CRM
function mapPriority(qValue) {
    if (!qValue) return { priority: 'medium', status: 'todo', stage: 'detected' }
    const q = qValue.toString().toUpperCase()
    if (q.includes('ПРИОРИТЕТ 1')) return { priority: 'critical', status: 'in_progress', stage: 'contacting' }
    if (q.includes('ПРИОРИТЕТ 2')) return { priority: 'high', status: 'in_progress', stage: 'contacting' }
    if (q.includes('КОНТРОЛЬ')) return { priority: 'medium', status: 'snoozed', stage: 'waiting_return' }
    if (q.includes('НЕ АКТИВЕН')) return { priority: 'low', status: 'todo', stage: 'detected' }
    if (q.includes('ОБНОВИТЬ ДАННЫЕ')) return { priority: 'medium', status: 'todo', stage: 'detected' }
    if (q.includes('НУЖНО ЗАПОЛНИТЬ')) return { priority: 'medium', status: 'todo', stage: 'detected' }
    return { priority: 'medium', status: 'todo', stage: 'detected' }
}

// Определить этап по данным менеджера
function determineStage(row) {
    const resultT = row['T'] // Результат Диалога
    const callN = row['N']   // Результат звонка
    const writeO = row['O']  // Написал если не дозвонился
    const priorityQ = row['Q']

    // Если есть результат диалога — причина собрана или предложение сделано
    if (resultT) {
        const t = resultT.toString().toLowerCase()
        if (t.includes('возвращается') || t.includes('вернулся') || t.includes('вернется') || t.includes('вернётся'))
            return 'waiting_return'
        if (t.includes('акци') || t.includes('без комиссии') || t.includes('предлож'))
            return 'offer_made'
        return 'reason_collected'
    }
    // Если был контакт (звонок/письмо) но нет результата
    if (callN && callN.toString().trim() !== '') {
        const n = callN.toString().toLowerCase()
        if (n.includes('не отв') || n.includes('не дозвон'))
            return 'contacting'
        return 'reason_collected'
    }
    if (writeO && writeO.toString().trim() !== '')
        return 'contacting'

    return 'detected'
}

// Подсчет касаний
function countAttempts(row) {
    let attempts = 0
    if (row['N'] && row['N'].toString().trim()) attempts++
    if (row['O'] && row['O'].toString().trim()) attempts++
    if (row['T'] && row['T'].toString().trim()) attempts++
    return attempts
}

// Определить месяц оттока -> дата
function churnMonthToDate(monthStr) {
    if (!monthStr) return new Date('2026-03-01')
    const m = monthStr.toString().toLowerCase().trim()
    if (m.includes('декабр') || m === 'декабрь') return new Date('2025-12-15')
    if (m.includes('январ') || m === 'январь') return new Date('2026-01-15')
    if (m.includes('феврал') || m === 'февраль') return new Date('2026-02-15')
    if (m.includes('мар') || m === 'март') return new Date('2026-03-15')
    return new Date('2026-03-01')
}

// Генерация заголовка задачи
function buildTitle(row) {
    const q = (row['Q'] || '').toString()
    if (q.includes('ПРИОРИТЕТ 1')) return 'Срочный возврат — активен у конкурента'
    if (q.includes('ПРИОРИТЕТ 2')) return 'Возврат — активен в Яндекс, ушёл в другой парк'
    if (q.includes('КОНТРОЛЬ')) return 'Контроль — временная причина, ждём возврата'
    if (q.includes('НЕ АКТИВЕН')) return 'Проверить шанс на реактивацию'
    if (q.includes('ОБНОВИТЬ ДАННЫЕ')) return 'Обновить данные — активность не уточнена'
    if (q.includes('НУЖНО ЗАПОЛНИТЬ')) return 'Заполнить данные — статус неизвестен'
    return 'Отток — требует обработки'
}

async function main() {
    console.log('📖 Читаю Excel...')
    const workbook = XLSX.readFile(EXCEL_PATH)
    const sheet = workbook.Sheets[SHEET_NAME]
    if (!sheet) {
        console.error(`Лист "${SHEET_NAME}" не найден!`)
        console.log('Доступные листы:', workbook.SheetNames)
        process.exit(1)
    }

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 'A', defval: '' })
    // Первая строка — заголовки, пропускаем
    const dataRows = rows.slice(1).filter(r => r['A'] && r['A'].toString().trim())
    console.log(`📊 Найдено ${dataRows.length} водителей в Excel`)

    // ─── Шаг 1: Удаляем текущие задачи оттока ───
    console.log('\n🗑️  Удаляю текущие задачи оттока...')
    const deletedEvents = await prisma.taskEvent.deleteMany({
        where: { task: { scenario: 'churn' } }
    })
    console.log(`   Удалено событий: ${deletedEvents.count}`)
    const deletedTasks = await prisma.task.deleteMany({
        where: { scenario: 'churn' }
    })
    console.log(`   Удалено задач: ${deletedTasks.count}`)

    // ─── Шаг 2: Подготовка водителей ───
    console.log('\n👤 Синхронизирую водителей...')
    // Получить всех существующих водителей по ФИО
    const existingDrivers = await prisma.driver.findMany({
        select: { id: true, fullName: true, phone: true }
    })
    const driverByName = new Map()
    for (const d of existingDrivers) {
        driverByName.set(d.fullName.toLowerCase().trim(), d)
    }

    let created = 0, matched = 0, tasks = 0

    // ─── Шаг 3: Создаём задачи ───
    console.log('\n📋 Создаю задачи оттока...')

    for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i]
        const fullName = row['A'].toString().trim()
        if (!fullName) continue

        const vuNumber = row['B'] ? row['B'].toString().trim() : ''

        // Найти или создать водителя
        let driver = driverByName.get(fullName.toLowerCase().trim())
        if (!driver) {
            // Создаём водителя
            driver = await prisma.driver.create({
                data: {
                    fullName: fullName,
                    phone: '',
                    yandexDriverId: `import_${vuNumber || Date.now()}_${i}`,
                },
                select: { id: true, fullName: true, phone: true }
            })
            driverByName.set(fullName.toLowerCase().trim(), driver)
            created++
        } else {
            matched++
        }

        // Маппинг полей
        const { priority, status, stage: defaultStage } = mapPriority(row['Q'])
        const stage = determineStage(row)
        const attempts = countAttempts(row)
        const churnDate = churnMonthToDate(row['J'])

        // Активность по месяцам
        const activity = {
            december: row['F'] ? row['F'].toString().toLowerCase().includes('да') : false,
            january: row['G'] ? row['G'].toString().toLowerCase().includes('да') : false,
            february: row['H'] ? row['H'].toString().toLowerCase().includes('да') : false,
            march: row['I'] ? row['I'].toString().toLowerCase().includes('да') : false,
        }

        // Данные конкурента
        const competitorPark = row['L'] ? row['L'].toString().trim() : ''
        const yandexTrips = row['M'] ? row['M'].toString().trim() : ''
        const worksInYandex = row['K'] ? row['K'].toString().toLowerCase().includes('да') : false

        // Результаты контакта менеджера
        const callResult = row['N'] ? row['N'].toString().trim() : ''
        const writeResult = row['O'] ? row['O'].toString().trim() : ''
        const managerAction = row['R'] ? row['R'].toString().trim() : ''
        const scriptText = row['S'] ? row['S'].toString().trim() : ''
        const dialogResult = row['T'] ? row['T'].toString().trim() : ''
        const priorityLabel = row['Q'] ? row['Q'].toString().trim() : ''

        // Описание задачи — компактная сводка
        const descParts = []
        if (vuNumber) descParts.push(`ВУ: ${vuNumber}`)
        descParts.push(`Месяц оттока: ${row['J'] || 'неизвестно'}`)
        descParts.push(`Активность: Дек=${activity.december ? 'Да' : 'Нет'}, Янв=${activity.january ? 'Да' : 'Нет'}, Фев=${activity.february ? 'Да' : 'Нет'}, Мар=${activity.march ? 'Да' : 'Нет'}`)
        if (worksInYandex) descParts.push(`Катает в Яндекс: Да`)
        else descParts.push(`Катает в Яндекс: Нет`)
        if (competitorPark) descParts.push(`Парк: ${competitorPark}`)
        if (yandexTrips) descParts.push(`Поездок в среднем: ${yandexTrips}`)
        const description = descParts.join('\n')

        // metadata — расширенные данные
        const metadata = {
            attempts,
            vuNumber,
            churnMonth: row['J'] ? row['J'].toString().trim() : '',
            activity,
            worksInYandex,
            competitorPark,
            yandexTrips,
            priorityLabel,
            ordersCompleted: row['C'] ? Number(row['C']) || 0 : 0,
            parkCommission: row['D'] ? Number(row['D']) || 0 : 0,
            hoursOnLine: row['E'] ? Number(row['E']) || 0 : 0,
            managerAction,
            scriptText,
        }

        // Определяем статус: если есть результат и водитель возвращается — done
        let finalStatus = status
        let closedReason = null
        let closedComment = null
        let resolvedAt = null
        let isActive = true

        if (dialogResult) {
            const dl = dialogResult.toLowerCase()
            if (dl.includes('возвращается') || dl.includes('вернулся')) {
                finalStatus = 'done'
                closedReason = 'returned'
                closedComment = dialogResult
                resolvedAt = new Date()
                isActive = false
            }
        }

        // SLA дедлайн
        const stageConfig = {
            detected: 24, contacting: 48, reason_collected: null,
            offer_made: 72, waiting_return: 168
        }
        const slaHours = stageConfig[stage]
        const now = new Date()
        const slaDeadline = slaHours ? new Date(now.getTime() + slaHours * 3600000) : null

        // Создаём задачу
        const task = await prisma.task.create({
            data: {
                driverId: driver.id,
                source: 'manual',
                type: 'inactive_followup',
                title: buildTitle(row),
                description,
                status: finalStatus,
                priority,
                isActive,
                scenario: 'churn',
                stage,
                stageEnteredAt: churnDate,
                slaDeadline,
                closedReason,
                closedComment,
                resolvedAt,
                createdBy: 'import_excel',
                metadata,
                createdAt: churnDate,
            }
        })

        // ─── Создаём события истории ───
        const events = []

        // 1. Событие создания
        events.push({
            taskId: task.id,
            eventType: 'created',
            payload: { source: 'excel_import', sheet: SHEET_NAME, priorityLabel },
            actorType: 'system',
            createdAt: churnDate,
        })

        // 2. Если был звонок (столбец N)
        if (callResult) {
            const isNoAnswer = callResult.toLowerCase().includes('не отв') || callResult.toLowerCase().includes('не дозвон')
            events.push({
                taskId: task.id,
                eventType: isNoAnswer ? 'called' : 'contacted',
                payload: {
                    method: 'phone',
                    result: callResult,
                    noAnswer: isNoAnswer,
                },
                actorType: 'user',
                actorId: 'manager',
                createdAt: new Date(churnDate.getTime() + 86400000), // +1 день после обнаружения
            })

            // Переход этапа на contacting
            events.push({
                taskId: task.id,
                eventType: 'stage_changed',
                payload: { from: 'detected', to: isNoAnswer ? 'contacting' : 'reason_collected' },
                actorType: 'user',
                createdAt: new Date(churnDate.getTime() + 86400000),
            })
        }

        // 3. Если написал (столбец O)
        if (writeResult) {
            events.push({
                taskId: task.id,
                eventType: 'wrote',
                payload: {
                    method: 'message',
                    channel: writeResult.toLowerCase().includes('тг') ? 'telegram' : 'whatsapp',
                    note: writeResult,
                },
                actorType: 'user',
                actorId: 'manager',
                createdAt: new Date(churnDate.getTime() + 2 * 86400000), // +2 дня
            })
        }

        // 4. Если есть результат диалога (столбец T)
        if (dialogResult) {
            events.push({
                taskId: task.id,
                eventType: 'comment',
                payload: { text: dialogResult, source: 'dialog_result' },
                actorType: 'user',
                actorId: 'manager',
                createdAt: new Date(churnDate.getTime() + 3 * 86400000), // +3 дня
            })

            // Если вернулся — закрываем
            if (closedReason === 'returned') {
                events.push({
                    taskId: task.id,
                    eventType: 'status_changed',
                    payload: { from: status, to: 'done', reason: 'returned', comment: dialogResult },
                    actorType: 'user',
                    actorId: 'manager',
                    createdAt: new Date(churnDate.getTime() + 3 * 86400000),
                })
            }
        }

        // Создаём все события
        if (events.length > 0) {
            await prisma.taskEvent.createMany({ data: events })
        }

        tasks++
        if (tasks % 50 === 0) console.log(`   Обработано: ${tasks}/${dataRows.length}`)
    }

    console.log(`\n✅ Импорт завершён!`)
    console.log(`   Водителей найдено: ${matched}`)
    console.log(`   Водителей создано: ${created}`)
    console.log(`   Задач оттока создано: ${tasks}`)

    // Итоговая статистика
    const stats = await prisma.task.groupBy({
        by: ['stage'],
        where: { scenario: 'churn' },
        _count: { id: true }
    })
    console.log('\n📊 Распределение по этапам:')
    for (const s of stats) {
        const labels = {
            detected: 'Обнаружен',
            contacting: 'Связываемся',
            reason_collected: 'Причина собрана',
            offer_made: 'Предложение сделано',
            waiting_return: 'Ждём возврата',
        }
        console.log(`   ${labels[s.stage] || s.stage}: ${s._count.id}`)
    }

    const priorityStats = await prisma.task.groupBy({
        by: ['priority'],
        where: { scenario: 'churn' },
        _count: { id: true }
    })
    console.log('\n📊 Распределение по приоритету:')
    for (const p of priorityStats) {
        console.log(`   ${p.priority}: ${p._count.id}`)
    }
}

main()
    .catch(e => { console.error(e); process.exit(1) })
    .finally(() => prisma.$disconnect())

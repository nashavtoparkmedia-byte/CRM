const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const CRITERIA = [
    { key: 'приветствие',          label: 'Приветствие и представление',          description: 'Назвал ли менеджер себя, парк, цель звонка. Тон вежливый, уверенный, без шаблонности.', scaleMax: 10, weight: 1,   isActive: true, order: 1 },
    { key: 'потребности',          label: 'Выявление потребностей',                description: 'Узнал ли менеджер опыт водителя, текущий парк/приложение, тип авто, готовность к смене условий, реальные мотивы.', scaleMax: 10, weight: 1,   isActive: true, order: 2 },
    { key: 'презентация',          label: 'Презентация условий парка',             description: 'Чётко ли названы комиссия, выплаты, поддержка, бонусы, гарантии. Без перегруза цифрами, под потребности водителя.', scaleMax: 10, weight: 1,   isActive: true, order: 3 },
    { key: 'возражения',           label: 'Работа с возражениями',                 description: 'Услышал ли менеджер возражения, признал ли их, ответил по существу, не давил ли.', scaleMax: 10, weight: 1,   isActive: true, order: 4 },
    { key: 'договорённость',       label: 'Договорённость о следующем шаге',       description: 'Зафиксирована ли конкретика: приехать оформиться, когда, куда, что взять; либо понятный отказ с фиксацией причины. «Подумаю» без даты и без перезвона — плохой результат.', scaleMax: 10, weight: 1.5, isActive: true, order: 5 },
    { key: 'тон',                  label: 'Тон и вежливость',                      description: 'Эмоциональный фон менеджера: вежливость, эмпатия, отсутствие хамства/раздражения/иронии в адрес водителя.', scaleMax: 10, weight: 1,   isActive: true, order: 6 },
    { key: 'настроение_менеджера', label: 'Настроение менеджера',                  description: 'Доброжелательность и искреннее желание помочь, слышное в тоне голоса. Энтузиазм, заинтересованность в водителе как в человеке. Отсутствие усталости, безразличия, формальности «по скрипту».', scaleMax: 10, weight: 1,   isActive: true, order: 7 },
    { key: 'качество_речи',        label: 'Качество речи',                         description: 'Чёткость произношения, темп, отсутствие слов-паразитов и долгих неуверенных пауз.', scaleMax: 10, weight: 0.5, isActive: true, order: 8 },
    { key: 'активное_слушание',    label: 'Активное слушание',                     description: 'Не перебивает, переспрашивает, подтверждает понимание, не «зачитывает скрипт» поверх ответов водителя.', scaleMax: 10, weight: 1,   isActive: true, order: 9 },
    { key: 'соблюдение_регламента',label: 'Соблюдение регламента',                 description: 'Прошёл ли менеджер обязательные пункты: комиссия, выплаты, документы, условия оформления.', scaleMax: 10, weight: 1,   isActive: true, order: 10 },
    { key: 'запрещённые_фразы',    label: 'Запрещённые формулировки',              description: 'Нет ли запрещённого: гарантии заработка цифрами, негатив про конкурентов, давление, обман по условиям. Высокий балл = чисто.', scaleMax: 10, weight: 1,  isActive: true, order: 11 },
]

const OUTCOMES = [
    { key: 'договорились_приехать', label: 'Договорились — водитель приедет',    isActive: true, order: 1 },
    { key: 'перезвонить_позже',     label: 'Думает, договорились перезвонить',   isActive: true, order: 2 },
    { key: 'заинтересован',         label: 'Заинтересован, без конкретной даты', isActive: true, order: 3 },
    { key: 'возражение_не_снято',   label: 'Возражение не снято',                isActive: true, order: 4 },
    { key: 'отказ',                 label: 'Отказался',                          isActive: true, order: 5 },
    { key: 'ошибка_номера',         label: 'Ошиблись номером / не тот человек', isActive: true, order: 6 },
    { key: 'связь_прервалась',      label: 'Связь прервалась / не состоялся',   isActive: true, order: 7 },
]

const SENTIMENTS = [
    { key: 'позитивный',  label: 'Позитивный',  isActive: true, order: 1 },
    { key: 'нейтральный', label: 'Нейтральный', isActive: true, order: 2 },
    { key: 'негативный',  label: 'Негативный',  isActive: true, order: 3 },
]

const NEXT_ACTIONS = [
    { key: 'перезвонить',      label: 'Перезвонить',           isActive: true, order: 1 },
    { key: 'визит_в_офис',     label: 'Приехать в офис',       isActive: true, order: 2 },
    { key: 'отправить_доки',   label: 'Отправить документы',   isActive: true, order: 3 },
    { key: 'отправить_ссылку', label: 'Отправить ссылку',      isActive: true, order: 4 },
    { key: 'не_требуется',     label: 'Действия не требуется', isActive: true, order: 5 },
]

async function main() {
    const updated = await prisma.telephonyAiConfig.upsert({
        where: { id: 'singleton' },
        update: {
            criteria: CRITERIA,
            outcomeOptions: OUTCOMES,
            sentimentOptions: SENTIMENTS,
            nextActionOptions: NEXT_ACTIONS,
        },
        create: {
            id: 'singleton',
            enabled: true,
            model: 'gpt-4o',
            systemPrompt: '(generated from criteria)',
            criteria: CRITERIA,
            outcomeOptions: OUTCOMES,
            sentimentOptions: SENTIMENTS,
            nextActionOptions: NEXT_ACTIONS,
        },
    })
    console.log('Reseeded. criteria:', updated.criteria?.length ?? 0,
                'outcomes:', updated.outcomeOptions?.length ?? 0,
                'sentiments:', updated.sentimentOptions?.length ?? 0,
                'next_actions:', updated.nextActionOptions?.length ?? 0)
    await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })

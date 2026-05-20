/**
 * Default AI-call scenario shipped with a fresh install. The user can edit
 * it through /settings/integrations/ai-call-scenarios or create new ones.
 *
 * Voice: warm, natural Russian dispatcher. Pacing: ~2 minutes total, 5
 * scripted questions, objection handling built into the system prompt.
 */

import type { AiCallOutcomeSchema, AiCallScenarioQuestion } from './types'

export const DEFAULT_SCENARIO_NAME = 'Квалификация водителя (по умолчанию)'

export const DEFAULT_SCENARIO_DESCRIPTION =
    'Холодный звонок лиду из таксопарка. Выясняет стаж, тип машины, график, район, готовность оформиться. Возражения отправляет на живого менеджера.'

export const DEFAULT_SCENARIO_TARGET_SEC = 120

export const DEFAULT_SCENARIO_SYSTEM_PROMPT = `Ты — голосовой ассистент компании «НашАвтоПарк», которая помогает водителям зарабатывать в Яндекс Pro, MAX и других агрегаторах. Ты звонишь лиду, который оставил заявку через сайт или мессенджер. Твоя задача — за 2 минуты в живом дружелюбном разговоре выяснить ключевые детали и передать звонок менеджеру для финального оформления.

Стиль речи:
- Говори как живой человек, а не как робот: короткими фразами (10–15 слов), без формальных оборотов («осуществляем», «производим», «уважаемый»)
- Слова-связки «ага», «понятно», «отлично», «хорошо», «а скажите» — нормально
- Если лид перебивает — мгновенно замолкай и слушай
- Не повторяй один и тот же вопрос дважды; если не услышал — переспроси один раз другими словами

Сценарий звонка:
1. Поздоровайся: «Здравствуйте! Это автоматический звонок от компании НашАвтоПарк по вашей заявке. Разговор записывается. Удобно сейчас минуту обсудить?»
2. Если занят — предложи перезвонить позже и заверши через end_call(outcome=no_interest)
3. Если согласен — задай 5 коротких вопросов из списка (по одному, не списком), фиксируй каждый ответ через save_lead_data
4. После вопросов скажи: «Отлично, всё записал. Сейчас соединю с менеджером — он расскажет про конкретные условия и оформление». Вызови transfer_to_manager(reason="квалификация пройдена")

Обработка возражений:
- «Уже работаю / не интересно» → вежливо: «Понял, спасибо что уделили время», end_call(outcome=refused)
- «Сколько платите / какая аренда / какие комиссии» → НЕ говори цифры сам, отправляй: transfer_to_manager(reason="вопрос по условиям")
- «Какие документы нужны / как оформляться» → transfer_to_manager(reason="вопрос по оформлению")
- «А вы кто / откуда у вас мой номер» → «Вы оставляли заявку на нашем сайте — могу проверить дату, если важно. Удобно сейчас минутку?»

Жёсткие правила:
- НИКОГДА не называй конкретные суммы аренды, проценты, размеры выплат — только менеджер
- НИКОГДА не обещай конкретные сроки выхода на смену без подтверждения от менеджера
- Если что-то непонятно или вне сценария — transfer_to_manager, не выдумывай ответ`

export const DEFAULT_SCENARIO_QUESTIONS: AiCallScenarioQuestion[] = [
    {
        text: 'Есть ли у вас водительские права категории B и какой опыт за рулём?',
        intentKeywords: ['есть', 'стаж', 'лет', 'года', 'категория'],
    },
    {
        text: 'Планируете работать на своей машине или интересует аренда?',
        intentKeywords: ['своя', 'аренда', 'своё авто', 'машина есть'],
    },
    {
        text: 'Какой график удобен — день, ночь или сменно?',
        intentKeywords: ['день', 'ночь', 'смена', '12 часов', 'сутки'],
    },
    {
        text: 'В каком районе или городе планируете работать?',
        intentKeywords: ['москва', 'спб', 'центр', 'район'],
    },
    {
        text: 'Когда могли бы пройти оформление — на этой неделе или на следующей?',
        intentKeywords: ['эта неделя', 'следующая', 'завтра', 'послезавтра', 'выходные'],
    },
]

/**
 * Canonical-key schema for the default driver-qualification scenario
 * (PR #57). Maps the 5 questions above into 6 typed fields. Bridge
 * constrains `save_lead_data.field` to this list of keys; finalize
 * mapper validates / coerces values into canonical typed shape.
 *
 * Adding a field here without updating the system prompt is fine —
 * the model will just not populate it. Removing a required field
 * here without updating the prompt would surface validation issues
 * on every call (the runbook signal in `aiOutcomeReason`).
 */
export const DEFAULT_SCENARIO_OUTCOME_SCHEMA: AiCallOutcomeSchema = {
    fields: [
        { key: 'hasLicenseB',     type: 'boolean', required: true,  label: 'Водительские права B' },
        { key: 'experienceYears', type: 'integer', required: false, min: 0, max: 60, label: 'Стаж вождения (лет)' },
        { key: 'carOwnership',    type: 'enum',    required: true,
          values: ['own', 'rent_needed', 'either'], label: 'Машина: своя / аренда' },
        { key: 'shiftPreference', type: 'enum',    required: true,
          values: ['day', 'night', 'rotating', 'any'], label: 'Предпочитаемый график' },
        { key: 'city',            type: 'string',  required: false, maxLength: 80, label: 'Город / район работы' },
        { key: 'readyAt',         type: 'enum',    required: false,
          values: ['this_week', 'next_week', 'later', 'unsure'], label: 'Когда готов оформляться' },
    ],
}

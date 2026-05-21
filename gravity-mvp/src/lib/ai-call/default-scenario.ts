/**
 * Default AI-call scenario shipped with a fresh install. The user can edit
 * it through /settings/integrations/ai-call-scenarios or create new ones.
 *
 * Voice: warm, natural Russian dispatcher. Pacing: ~2 minutes total, 5
 * scripted questions, objection handling built into the system prompt.
 */

import type {
    AiCallGreetingVariant,
    AiCallOutcomeSchema,
    AiCallScenarioFragments,
    AiCallScenarioQuestion,
} from './types'

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

/**
 * Greeting A/B variants for the default driver-qualification scenario
 * (PR #62). The bridge deterministically picks one via
 * `hash(callUuid) % N` and speaks it directly (no LLM round-trip on
 * greeting). Variant id lands in `greeting_started.payload.variant_id`
 * for funnel attribution.
 *
 * Variant A (baseline) — the current pre-PR-62 wording, kept verbatim
 *   so the A/B test measures a true delta against historical data.
 *
 * Variant B (ultra-short) — strips the «automatic call» mention and
 *   the recording-warning, compresses to "who + immediate ask". Tests
 *   whether the longer wording was driving the 29% pre-greeting drop.
 *
 * Variant C (more human) — informal-but-still-disclosed phrasing.
 *   Tests whether dropping "автоматический" while keeping context
 *   ("вы оставляли заявку") improves engagement vs. variant B.
 *
 * Three variants is the maximum the architect approved for v1; adding
 * more requires a new PR. Same hash bucket policy applies — fewer
 * variants ⇒ wider buckets ⇒ faster statistical signal per variant.
 */
export const DEFAULT_SCENARIO_GREETING_VARIANTS: AiCallGreetingVariant[] = [
    {
        id: 'A',
        label: 'Baseline (формальный, с упоминанием записи)',
        text:
            'Здравствуйте! Это автоматический звонок от компании НашАвтоПарк ' +
            'по вашей заявке. Разговор записывается. Удобно сейчас минуту обсудить?',
    },
    {
        id: 'B',
        label: 'Ultra-short (без «автоматический», без упоминания записи)',
        text: 'Здравствуйте! НашАвтоПарк по вашей заявке. Удобно сейчас минуту?',
    },
    {
        id: 'C',
        label: 'Human (без «автоматический», контекст «вы оставляли заявку»)',
        text: 'Здравствуйте! Это НашАвтоПарк — вы оставляли у нас заявку. Удобно говорить?',
    },
]

/**
 * Default scenario prompt fragments (PR #63). Exposed as a const so a
 * PM / admin can opt the default scenario into the fragment path with
 * one click in a future UI. NOT applied to the seeded default scenario
 * by default — existing prod scenarios stay on the legacy monolithic
 * prompt path until the architect chooses to switch.
 *
 * Composed by tools/audio-bridge-day1/prompt-fragments.js into the
 * system prompt at call start. Order:
 *   [greeting] [qualification_intro] [questions block]
 *   [speech + scenario rules — scaffolding]
 *   [transfer_framing] [objection_soft?] [recovery] [closing?]
 *   [canonical-keys cheat sheet, if outcomeSchema set]
 *   [end_call qualification_score nudge]
 *
 * Each fragment has an `id` + `version`. When a fragment is iterated,
 * bump the version (or change the id) so funnel attribution can tell
 * old text from new.
 */
export const DEFAULT_SCENARIO_FRAGMENTS_V1: AiCallScenarioFragments = {
    greeting: {
        id: 'default-greeting',
        version: 1,
        text:
            'Ты — голосовой ассистент компании «НашАвтоПарк», которая помогает водителям ' +
            'зарабатывать в Яндекс Pro, MAX и других агрегаторах. Ты звонишь лиду, ' +
            'который оставил заявку через сайт или мессенджер.',
    },
    qualification_intro: {
        id: 'default-qual-intro',
        version: 1,
        text:
            'Твоя задача — за 2 минуты в живом дружелюбном разговоре выяснить ключевые ' +
            'детали и передать звонок менеджеру для финального оформления. Стиль речи: ' +
            'короткие фразы (10–15 слов), без формальных оборотов. Слова-связки «ага», ' +
            '«понятно», «отлично» — нормально.',
    },
    transfer_framing: {
        id: 'default-transfer-framing',
        version: 1,
        text:
            'Когда все 5 вопросов закрыты — скажи: «Отлично, всё записал. Сейчас соединю ' +
            'с менеджером — он расскажет про конкретные условия и оформление». Затем ' +
            'вызови transfer_to_manager(reason="квалификация пройдена").',
        hypothesis:
            'Явная отсылка к «менеджер расскажет конкретные условия» снижает падение ' +
            'на этом шаге; без этого лиды иногда вешали трубку до transfer.',
    },
    recovery: {
        id: 'default-recovery',
        version: 1,
        text:
            'Если лид молчит или STT прислал мусор: переспроси один раз коротко ' +
            '(«Не расслышал, повторите?»). Дважды НЕ переспрашивай — лучше задай ' +
            'следующий вопрос. Не повторяй greeting целиком.',
    },
    objection_soft: {
        id: 'default-objection-soft',
        version: 1,
        text:
            'Обработка возражений:\n' +
            '— «Уже работаю / не интересно» → вежливо: «Понял, спасибо что уделили время», ' +
            'end_call(qualification_status=not_qualified).\n' +
            '— «Сколько платите / какая аренда / какие комиссии» → НЕ говори цифры сам, ' +
            'transfer_to_manager(reason="вопрос по условиям").\n' +
            '— «Какие документы / как оформляться» → transfer_to_manager(reason="вопрос по оформлению").\n' +
            '— «А вы кто / откуда у вас мой номер» → «Вы оставляли заявку на нашем сайте — ' +
            'могу проверить дату, если важно. Удобно сейчас минутку?»',
        hypothesis:
            'Деление возражений на 4 explicit кейса снижает дрейф LLM в свободную ' +
            'интерпретацию и часто-наблюдаемый «понял, спасибо» на любой push-back.',
    },
    closing: {
        id: 'default-closing',
        version: 1,
        text:
            'Жёсткие правила:\n' +
            '— НИКОГДА не называй конкретные суммы, проценты, размеры выплат — только менеджер.\n' +
            '— НИКОГДА не обещай конкретные сроки выхода на смену без подтверждения от менеджера.\n' +
            '— Если что-то непонятно или вне сценария — transfer_to_manager, не выдумывай ответ.',
    },
}

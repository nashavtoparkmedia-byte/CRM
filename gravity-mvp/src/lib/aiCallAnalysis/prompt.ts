/**
 * Dynamic AI call-analysis prompt + parser.
 *
 * The rubric is no longer hard-coded. TelephonyAiConfig stores arrays of
 * criteria + outcome/sentiment/next-action options, an admin edits them
 * through /settings/integrations/telephony-ai, and we re-generate both the
 * system prompt and the response parser on the fly from those arrays.
 *
 * Default arrays below seed the singleton on first read so the UI never
 * shows an empty form — admins can edit, reorder, disable, add new entries.
 *
 * OpenAI auto-caches prompt prefixes ≥1024 tokens for ~5 min. Our generated
 * prompt is well over that and stable between calls — re-running analyses
 * back-to-back pays only for the transcript portion once the cache is warm.
 */

export interface CriterionConfig {
    key: string
    label: string
    description: string
    scaleMax: number
    weight: number
    isActive: boolean
    order: number
}

export interface OptionConfig {
    key: string
    label: string
    isActive: boolean
    order: number
}

export interface RubricConfig {
    criteria: CriterionConfig[]
    outcomeOptions: OptionConfig[]
    sentimentOptions: OptionConfig[]
    nextActionOptions: OptionConfig[]
}

export interface CallAnalysisResult {
    scores: Record<string, number>
    summary: string
    red_flags: string[]
    outcome: string | null
    client_sentiment: string | null
    next_action_type: string | null
    next_action_due: string | null  // ISO date or null
}

// ── Default seeds ────────────────────────────────────────────────────────

export const DEFAULT_CRITERIA: CriterionConfig[] = [
    {
        key: 'приветствие',
        label: 'Приветствие и представление',
        description: 'Назвал ли менеджер себя, парк, цель звонка. Тон вежливый, уверенный, без шаблонности.',
        scaleMax: 10, weight: 1, isActive: true, order: 1,
    },
    {
        key: 'потребности',
        label: 'Выявление потребностей',
        description: 'Узнал ли менеджер опыт водителя, текущий парк/приложение, тип авто, готовность к смене условий, реальные мотивы.',
        scaleMax: 10, weight: 1, isActive: true, order: 2,
    },
    {
        key: 'презентация',
        label: 'Презентация условий парка',
        description: 'Чётко ли названы комиссия, выплаты, поддержка, бонусы, гарантии. Без перегруза цифрами, под потребности водителя.',
        scaleMax: 10, weight: 1, isActive: true, order: 3,
    },
    {
        key: 'возражения',
        label: 'Работа с возражениями',
        description: 'Услышал ли менеджер возражения, признал ли их, ответил по существу, не давил ли.',
        scaleMax: 10, weight: 1, isActive: true, order: 4,
    },
    {
        key: 'договорённость',
        label: 'Договорённость о следующем шаге',
        description: 'Зафиксирована ли конкретика: приехать оформиться, когда, куда, что взять; либо понятный отказ с фиксацией причины. «Подумаю» без даты и без перезвона — плохой результат.',
        scaleMax: 10, weight: 1.5, isActive: true, order: 5,
    },
    {
        key: 'тон',
        label: 'Тон и вежливость',
        description: 'Эмоциональный фон менеджера: вежливость, эмпатия, отсутствие хамства/раздражения/иронии в адрес водителя.',
        scaleMax: 10, weight: 1, isActive: true, order: 6,
    },
    {
        key: 'настроение_менеджера',
        label: 'Настроение менеджера',
        description: 'Доброжелательность и искреннее желание помочь, слышное в тоне голоса. Энтузиазм, заинтересованность в водителе как в человеке. Отсутствие усталости, безразличия, формальности «по скрипту».',
        scaleMax: 10, weight: 1, isActive: true, order: 7,
    },
    {
        key: 'качество_речи',
        label: 'Качество речи',
        description: 'Чёткость произношения, темп, отсутствие слов-паразитов и долгих неуверенных пауз.',
        scaleMax: 10, weight: 0.5, isActive: true, order: 8,
    },
    {
        key: 'активное_слушание',
        label: 'Активное слушание',
        description: 'Не перебивает, переспрашивает, подтверждает понимание, не «зачитывает скрипт» поверх ответов водителя.',
        scaleMax: 10, weight: 1, isActive: true, order: 9,
    },
    {
        key: 'соблюдение_регламента',
        label: 'Соблюдение регламента',
        description: 'Прошёл ли менеджер обязательные пункты: комиссия, выплаты, документы, условия оформления.',
        scaleMax: 10, weight: 1, isActive: true, order: 10,
    },
    {
        key: 'запрещённые_фразы',
        label: 'Запрещённые формулировки',
        description: 'Нет ли запрещённого: гарантии заработка цифрами, негатив про конкурентов, давление, обман по условиям. Высокий балл = чисто.',
        scaleMax: 10, weight: 1, isActive: true, order: 11,
    },
]

export const DEFAULT_OUTCOME_OPTIONS: OptionConfig[] = [
    { key: 'договорились_приехать',  label: 'Договорились — водитель приедет',     isActive: true, order: 1 },
    { key: 'перезвонить_позже',      label: 'Думает, договорились перезвонить',    isActive: true, order: 2 },
    { key: 'заинтересован',          label: 'Заинтересован, без конкретной даты',  isActive: true, order: 3 },
    { key: 'возражение_не_снято',    label: 'Возражение не снято',                 isActive: true, order: 4 },
    { key: 'отказ',                  label: 'Отказался',                           isActive: true, order: 5 },
    { key: 'ошибка_номера',          label: 'Ошиблись номером / не тот человек',  isActive: true, order: 6 },
    { key: 'связь_прервалась',       label: 'Связь прервалась / не состоялся',    isActive: true, order: 7 },
]

export const DEFAULT_SENTIMENT_OPTIONS: OptionConfig[] = [
    { key: 'позитивный',  label: 'Позитивный',  isActive: true, order: 1 },
    { key: 'нейтральный', label: 'Нейтральный', isActive: true, order: 2 },
    { key: 'негативный',  label: 'Негативный',  isActive: true, order: 3 },
]

export const DEFAULT_NEXT_ACTION_OPTIONS: OptionConfig[] = [
    { key: 'перезвонить',     label: 'Перезвонить',           isActive: true, order: 1 },
    { key: 'визит_в_офис',    label: 'Приехать в офис',       isActive: true, order: 2 },
    { key: 'отправить_доки',  label: 'Отправить документы',   isActive: true, order: 3 },
    { key: 'отправить_ссылку',label: 'Отправить ссылку',      isActive: true, order: 4 },
    { key: 'не_требуется',    label: 'Действия не требуется', isActive: true, order: 5 },
]

// ── Prompt builder ───────────────────────────────────────────────────────

function activeSorted<T extends { isActive: boolean; order: number }>(arr: T[]): T[] {
    return arr.filter(x => x.isActive).sort((a, b) => a.order - b.order)
}

export function buildSystemPrompt(cfg: RubricConfig): string {
    const criteria = activeSorted(cfg.criteria)
    const outcomes = activeSorted(cfg.outcomeOptions)
    const sentiments = activeSorted(cfg.sentimentOptions)
    const nextActions = activeSorted(cfg.nextActionOptions)

    const criteriaList = criteria.map((c, i) => {
        return `${i + 1}. ${c.key} — ${c.label}.\n   Шкала: 1–${c.scaleMax}. ${c.description}`
    }).join('\n')

    const scoresSchema = criteria.map(c => `    "${c.key}": <1-${c.scaleMax}>`).join(',\n')

    const outcomesList = outcomes.map(o => `   - "${o.key}" — ${o.label}`).join('\n')
    const sentimentsList = sentiments.map(o => `   - "${o.key}" — ${o.label}`).join('\n')
    const nextActionsList = nextActions.map(o => `   - "${o.key}" — ${o.label}`).join('\n')

    return `Ты — старший супервизор отдела водителей таксопарка NashAvtoParkMedia.
Тебе передают расшифровку телефонного звонка между менеджером парка и водителем
(потенциальным или действующим). Менеджер пытается привлечь / удержать водителя
в парке. Твоя задача — оценить работу менеджера, а не работу водителя.

Оцени менеджера по следующим критериям. Для каждого выставь целочисленный балл
от 1 до шкалы критерия:

${criteriaList}

Если критерий неприменим (например, звонок прервался на 5 секунде — презентации
физически не было), всё равно поставь балл: 1 если этап был критически важен и
провален, середина шкалы (~5/10) если этап не наступил по уважительной причине.

Помимо баллов выбери одно значение из каждого справочника:

— outcome (итог звонка), одно из:
${outcomesList}

— client_sentiment (настроение клиента), одно из:
${sentimentsList}

— next_action_type (тип следующего действия), одно из:
${nextActionsList}

— next_action_due — дата следующего действия в формате ISO YYYY-MM-DD,
  или null если действие не требуется / тип "none".

Также:
- summary — 2–3 предложения по-русски. Что произошло, какой исход, кто и
  что должен сделать дальше. Без воды, без оценочных эпитетов.
- red_flags — массив коротких строк, каждая — конкретное проблемное
  высказывание менеджера или нарушение скрипта. Пустой массив [], если
  всё чисто. Не выдумывай — только то, что реально было в расшифровке.

Верни ОДИН JSON-объект строго по схеме:
{
  "scores": {
${scoresSchema}
  },
  "summary": "<2-3 предложения>",
  "red_flags": ["<строка>", ...],
  "outcome": "<key из списка outcome или null>",
  "client_sentiment": "<key из списка sentiment или null>",
  "next_action_type": "<key из списка next_action или null>",
  "next_action_due": "<YYYY-MM-DD или null>"
}

Все ключи в scores обязательны и должны совпадать с перечисленными выше.
summary — строка. red_flags — массив строк. outcome / sentiment / next_action_type —
один из перечисленных ключей или null. next_action_due — ISO-строка или null.
Никаких дополнительных полей.`
}

// ── Response parser ──────────────────────────────────────────────────────

/**
 * Validate the GPT-4o JSON response against the active rubric. Returns
 * the cleaned-up object, or throws so the BullMQ worker can mark the job
 * as failed and retry.
 */
export function parseAnalysisResponse(raw: unknown, cfg: RubricConfig): CallAnalysisResult {
    if (!raw || typeof raw !== 'object') {
        throw new Error('analysis response is not an object')
    }
    const obj = raw as Record<string, unknown>

    const criteria = activeSorted(cfg.criteria)
    const scoresRaw = obj.scores as Record<string, unknown> | undefined
    if (!scoresRaw || typeof scoresRaw !== 'object') {
        throw new Error('analysis response missing "scores" object')
    }
    const scores: Record<string, number> = {}
    for (const c of criteria) {
        const v = scoresRaw[c.key]
        const n = typeof v === 'number' ? v : Number(v)
        if (!Number.isFinite(n) || n < 1 || n > c.scaleMax) {
            throw new Error(`scores.${c.key} is not 1-${c.scaleMax} (got ${JSON.stringify(v)})`)
        }
        scores[c.key] = Math.round(n)
    }

    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
    if (!summary) throw new Error('analysis response missing "summary" string')

    const redFlagsRaw = obj.red_flags
    const red_flags: string[] = Array.isArray(redFlagsRaw)
        ? redFlagsRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(s => s.trim())
        : []

    // Optional enums — model may return null. Validate against active keys.
    const validKeys = (opts: OptionConfig[]) => new Set(activeSorted(opts).map(o => o.key))
    const outcomeKeys = validKeys(cfg.outcomeOptions)
    const sentimentKeys = validKeys(cfg.sentimentOptions)
    const nextActionKeys = validKeys(cfg.nextActionOptions)

    const pickEnum = (v: unknown, valid: Set<string>): string | null => {
        if (typeof v !== 'string') return null
        const t = v.trim()
        if (!t || t.toLowerCase() === 'null') return null
        return valid.has(t) ? t : null
    }

    const outcome = pickEnum(obj.outcome, outcomeKeys)
    const client_sentiment = pickEnum(obj.client_sentiment, sentimentKeys)
    const next_action_type = pickEnum(obj.next_action_type, nextActionKeys)

    let next_action_due: string | null = null
    if (typeof obj.next_action_due === 'string') {
        const trimmed = obj.next_action_due.trim()
        if (trimmed && trimmed.toLowerCase() !== 'null') {
            // Accept YYYY-MM-DD; tolerate full ISO timestamps too
            const d = new Date(trimmed)
            if (!Number.isNaN(d.getTime())) {
                next_action_due = d.toISOString()
            }
        }
    }

    return { scores, summary, red_flags, outcome, client_sentiment, next_action_type, next_action_due }
}

/**
 * Weighted average of criterion scores → integer 1–10 for the headline
 * Call.aiScore. Criteria scaleMax are normalised to a 1–10 axis first.
 * Used by list views for sorting / filtering ("best calls today").
 */
export function averageScore(scores: Record<string, number>, cfg: RubricConfig): number {
    const criteria = activeSorted(cfg.criteria).filter(c => scores[c.key] != null)
    if (criteria.length === 0) return 1

    let totalWeight = 0
    let weighted = 0
    for (const c of criteria) {
        const norm10 = (scores[c.key] / c.scaleMax) * 10
        weighted += norm10 * c.weight
        totalWeight += c.weight
    }
    const avg = weighted / totalWeight
    return Math.max(1, Math.min(10, Math.round(avg)))
}

/**
 * Snapshot of the legacy hard-coded prompt — kept ONLY for the "Сбросить
 * к шаблону" button in the AI rubric editor (legacy textarea fallback for
 * admins who still use the free-form prompt instead of structured criteria).
 * The active codepath ignores this and uses buildSystemPrompt(cfg) instead.
 */
export const DEFAULT_SYSTEM_PROMPT = buildSystemPrompt({
    criteria: DEFAULT_CRITERIA,
    outcomeOptions: DEFAULT_OUTCOME_OPTIONS,
    sentimentOptions: DEFAULT_SENTIMENT_OPTIONS,
    nextActionOptions: DEFAULT_NEXT_ACTION_OPTIONS,
})

/**
 * Default system prompt for evaluating a manager's call with a driver.
 *
 * The prompt is intentionally long and stable — OpenAI automatically caches
 * the prefix of any prompt ≥1024 tokens for ~5 minutes, billing cached
 * portions at ~50% of normal input cost. The system prompt below is well
 * over that threshold, so back-to-back call analyses pay only for the
 * transcript itself once the cache is warm.
 *
 * The configurable part is stored in TelephonyAiConfig.systemPrompt — admins
 * can tune the rubric without a redeploy via /settings/integrations/telephony-ai.
 * If that row is missing or empty, we fall back to this constant.
 */

export const DEFAULT_SYSTEM_PROMPT = `Ты — старший супервизор отдела водителей таксопарка NashAvtoParkMedia.
Тебе передают расшифровку телефонного звонка между менеджером парка и водителем
(потенциальным или действующим). Менеджер пытается привлечь / удержать водителя
в парке. Твоя задача — оценить работу менеджера, а не работу водителя.

Оцени менеджера по 5 критериям. Для каждого выставь целочисленный балл 1–10:

1. greeting     — Приветствие и представление.
                  Назвал ли менеджер себя, парк, цель звонка? Тон вежливый,
                  уверенный, без шаблонности?
2. needs        — Выявление потребностей водителя.
                  Узнал ли менеджер опыт работы, текущий парк / приложение,
                  тип авто, готовность к смене условий, реальные мотивы?
3. presentation — Презентация условий парка.
                  Чётко ли названы комиссия, выплаты, поддержка, бонусы,
                  гарантии? Без перегруза цифрами, под потребности водителя?
4. objections   — Обработка возражений.
                  Услышал ли менеджер возражения, признал ли их, ответил
                  по существу, не давил ли?
5. next_step    — Договорённость о следующем шаге.
                  Зафиксирована ли конкретика: приехать оформиться, когда,
                  куда, что взять; либо понятный отказ с фиксацией причины?
                  «Подумаю» без даты и без перезвона — это плохой next_step.

Если критерий неприменим (например, звонок прервался на 5 секунде —
презентации физически не было), всё равно поставь балл 1–10: 1 если этап
был критически важен и провален, 5 если этап не наступил по уважительной
причине, не показательной для менеджера.

Помимо баллов:
- summary — 2–3 предложения по-русски. Что произошло, какой исход, кто и
  что должен сделать дальше. Без воды, без оценочных эпитетов.
- red_flags — массив коротких строк, каждая — конкретное проблемное
  высказывание менеджера или нарушение скрипта. Пустой массив [], если
  всё чисто. Не выдумывай — только то, что реально было в расшифровке.

Верни ОДИН JSON-объект строго по схеме:
{
  "scores": {
    "greeting": <1-10>,
    "needs": <1-10>,
    "presentation": <1-10>,
    "objections": <1-10>,
    "next_step": <1-10>
  },
  "summary": "<2-3 предложения>",
  "red_flags": ["<строка>", ...]
}

Все 5 ключей в scores обязательны. summary — строка. red_flags — массив строк
(пустой массив, если проблем нет). Никаких дополнительных полей.`

export interface CallAnalysisResult {
    scores: {
        greeting: number
        needs: number
        presentation: number
        objections: number
        next_step: number
    }
    summary: string
    red_flags: string[]
}

/**
 * Validate that an arbitrary parsed JSON value matches the expected shape.
 * Returns the cleaned-up object or throws with a descriptive error so the
 * BullMQ worker can mark the job as failed and retry.
 */
export function parseAnalysisResponse(raw: unknown): CallAnalysisResult {
    if (!raw || typeof raw !== 'object') {
        throw new Error('analysis response is not an object')
    }
    const obj = raw as Record<string, unknown>
    const scores = obj.scores as Record<string, unknown> | undefined
    if (!scores || typeof scores !== 'object') {
        throw new Error('analysis response missing "scores" object')
    }

    const keys = ['greeting', 'needs', 'presentation', 'objections', 'next_step'] as const
    const cleanScores = {} as CallAnalysisResult['scores']
    for (const k of keys) {
        const v = scores[k]
        const n = typeof v === 'number' ? v : Number(v)
        if (!Number.isFinite(n) || n < 1 || n > 10) {
            throw new Error(`scores.${k} is not 1-10 (got ${JSON.stringify(v)})`)
        }
        cleanScores[k] = Math.round(n)
    }

    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
    if (!summary) throw new Error('analysis response missing "summary" string')

    const redFlagsRaw = obj.red_flags
    const red_flags: string[] = Array.isArray(redFlagsRaw)
        ? redFlagsRaw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(s => s.trim())
        : []

    return { scores: cleanScores, summary, red_flags }
}

/**
 * Average of the 5 criterion scores, rounded to an integer 1-10.
 * Used as the headline Call.aiScore so list views can sort / filter by
 * "best calls today" without unpacking JSON.
 */
export function averageScore(scores: CallAnalysisResult['scores']): number {
    const total = scores.greeting + scores.needs + scores.presentation + scores.objections + scores.next_step
    return Math.max(1, Math.min(10, Math.round(total / 5)))
}

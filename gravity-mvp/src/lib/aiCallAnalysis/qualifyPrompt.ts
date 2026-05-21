/**
 * Fallback qualification extractor for AI-call transcripts.
 *
 * When a live AI-call ends WITHOUT the LLM reaching the `end_call` tool —
 * e.g. the lead hung up early, or the dialog hit a guardrail — the bridge
 * finalizes the Call row with `aiAnalysis = null`. This module runs after
 * the fact, reads `Call.transcript` (the line-by-line live mirror the
 * bridge streamed in), and asks GPT to extract the same shape the bridge
 * would have produced from `end_call`:
 *
 *   QualificationResult {
 *     qualification_status: 'qualified' | 'not_qualified' | 'unclear'
 *     reason: string
 *     lead_summary?: string
 *     answers: { has_license, license_categories, experience_years,
 *                city, desired_schedule, ready_to_start_within_days,
 *                objections }
 *     manager_task?: { should_create, priority, summary }
 *   }
 *
 * The shape matches what CallDetailClient.tsx renders in the «AI-анализ»
 * tab — both the live-LLM path and this fallback feed the same UI.
 *
 * Important: this is NOT the manager-evaluation rubric in prompt.ts.
 * That one scores a human manager's call by 5 criteria. AI-calls have no
 * human manager; the question is "what did we learn about the lead". So
 * we keep the two prompts side-by-side and branch in analyzeWorker on
 * Call.isAi.
 */

export const DEFAULT_QUALIFY_PROMPT = `Ты — аналитик отдела водителей таксопарка NashAvtoParkMedia.
Тебе передают расшифровку телефонного звонка между AI-ассистентом парка и
лидом (потенциальным водителем), который оставил заявку. AI-ассистент
квалифицирует лида по короткому сценарию. Звонок мог оборваться рано или
пройти полностью.

Твоя задача — извлечь из расшифровки то, что AI-ассистент УСПЕЛ узнать,
и решить, готов ли лид к передаче менеджеру.

Поля:

1. qualification_status — итог:
   - "qualified"        — лид подходит и готов работать. Подтвердил права,
                          интерес и желание продолжать.
   - "not_qualified"    — лид прямо отказался или явно не подходит
                          (нет прав, агрессия, не интересно, занят
                          и не хочет перезвон, ошибся номером).
   - "unclear"          — данных недостаточно. Лид молчал, звонок
                          оборвался рано, ответы непонятны / противоречивы,
                          STT прислал мусор.
   Когда сомневаешься — "unclear". Не натягивай "qualified" на короткий
   разговор.

2. reason — одно предложение по-русски, почему именно такой статус.
   Конкретно: «лид сразу повесил трубку», «подтвердил права B и опыт 3 года»,
   «отказался обсуждать», «потерял связь после первого вопроса».

3. lead_summary — 1–2 предложения по-русски о лиде целиком: что узнали,
   контекст, общее впечатление. Подойдёт как preview в карточке звонка.
   Не выдумывай факты — только то, что реально звучало.

4. answers — структурированные ответы лида. Заполняй ТОЛЬКО те поля,
   которые лид действительно озвучил. Не уверен — оставь null или []:
   - has_license: boolean | null               — права у лида есть?
   - license_categories: string[]              — категории, если назвал (B, C, ...)
   - experience_years: number | null           — стаж за рулём в годах
   - city: string | null                       — город / регион работы
   - desired_schedule: "day"|"night"|"shifts"|"any"|"unknown"
   - ready_to_start_within_days: number | null — через сколько дней готов выйти
   - objections: string[]                      — возражения / вопросы, если были

5. manager_task — задача для живого менеджера:
   - should_create: boolean                    — нужно ли создавать?
                                                  qualified ⇒ true.
                                                  not_qualified (отказ) ⇒ false.
                                                  unclear ⇒ true, если разговор
                                                  оборвался И не было явного
                                                  отказа (нужен ручной перезвон);
                                                  false, если лид агрессивен.
   - priority: "high"|"normal"|"low"           — high для qualified;
                                                  normal для unclear+перезвон;
                                                  low для остального.
   - summary: string                           — что менеджер должен сделать.
                                                  Конкретно: «перезвонить через
                                                  час: лид подтвердил права, не
                                                  успели обсудить аренду».

Верни ОДИН JSON-объект строго по схеме:
{
  "qualification_status": "qualified" | "not_qualified" | "unclear",
  "reason": "<одно предложение>",
  "lead_summary": "<1–2 предложения>",
  "answers": {
    "has_license": <bool | null>,
    "license_categories": [ "<строка>", ... ],
    "experience_years": <number | null>,
    "city": "<string | null>",
    "desired_schedule": "day" | "night" | "shifts" | "any" | "unknown",
    "ready_to_start_within_days": <number | null>,
    "objections": [ "<строка>", ... ]
  },
  "manager_task": {
    "should_create": <bool>,
    "priority": "high" | "normal" | "low",
    "summary": "<строка>"
  }
}

Жёсткие правила:
— ОБЯЗАТЕЛЬНО заполни qualification_status, reason, lead_summary,
  answers, manager_task. Никаких дополнительных полей.
— Все массивы — массивы строк. Пустой массив [] разрешён.
— Не выдумывай факты. Лид не говорил про машину — has_license=null или
  license_categories=[].
— Если транскрипт явно мусорный (STT уехал, эхо TTS), не пытайся
  «понять» — ставь unclear, lead_summary опиши проблему.`

export type QualificationStatus = 'qualified' | 'not_qualified' | 'unclear'
export type DesiredSchedule = 'day' | 'night' | 'shifts' | 'any' | 'unknown'

export interface QualificationResult {
    qualification_status: QualificationStatus
    reason: string
    lead_summary: string
    answers: {
        has_license: boolean | null
        license_categories: string[]
        experience_years: number | null
        city: string | null
        desired_schedule: DesiredSchedule
        ready_to_start_within_days: number | null
        objections: string[]
    }
    manager_task: {
        should_create: boolean
        priority: 'high' | 'normal' | 'low'
        summary: string
    }
}

/**
 * Validate that GPT's JSON output matches QualificationResult. Throws with a
 * descriptive message so the BullMQ worker can mark the job as failed and
 * retry up to N attempts. Soft-validates: missing optional sub-fields are
 * filled with sane defaults rather than rejected — GPT-4o is reliable on
 * the top-level shape but occasionally omits a sub-key on short transcripts.
 */
export function parseQualifyResponse(raw: unknown): QualificationResult {
    if (!raw || typeof raw !== 'object') {
        throw new Error('qualify response is not an object')
    }
    const obj = raw as Record<string, unknown>

    const status = obj.qualification_status
    if (status !== 'qualified' && status !== 'not_qualified' && status !== 'unclear') {
        throw new Error(`qualification_status must be qualified|not_qualified|unclear (got ${JSON.stringify(status)})`)
    }

    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : ''
    if (!reason) throw new Error('reason is missing or empty')

    const lead_summary = typeof obj.lead_summary === 'string' ? obj.lead_summary.trim() : ''
    if (!lead_summary) throw new Error('lead_summary is missing or empty')

    const answersRaw = (obj.answers && typeof obj.answers === 'object' ? obj.answers : {}) as Record<string, unknown>
    const sched = answersRaw.desired_schedule
    const desired_schedule: DesiredSchedule =
        sched === 'day' || sched === 'night' || sched === 'shifts' || sched === 'any'
            ? sched
            : 'unknown'

    const answers: QualificationResult['answers'] = {
        has_license: nullableBool(answersRaw.has_license),
        license_categories: stringArray(answersRaw.license_categories),
        experience_years: nullableNumber(answersRaw.experience_years),
        city: nullableString(answersRaw.city),
        desired_schedule,
        ready_to_start_within_days: nullableNumber(answersRaw.ready_to_start_within_days),
        objections: stringArray(answersRaw.objections),
    }

    const mtRaw = (obj.manager_task && typeof obj.manager_task === 'object' ? obj.manager_task : {}) as Record<string, unknown>
    const priorityRaw = mtRaw.priority
    const priority: QualificationResult['manager_task']['priority'] =
        priorityRaw === 'high' || priorityRaw === 'low' ? priorityRaw : 'normal'

    const manager_task: QualificationResult['manager_task'] = {
        should_create: Boolean(mtRaw.should_create),
        priority,
        summary: typeof mtRaw.summary === 'string' ? mtRaw.summary.trim() : '',
    }

    return {
        qualification_status: status,
        reason,
        lead_summary,
        answers,
        manager_task,
    }
}

function nullableBool(v: unknown): boolean | null {
    if (v === true || v === false) return v
    return null
}
function nullableNumber(v: unknown): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
    return null
}
function nullableString(v: unknown): string | null {
    if (typeof v !== 'string') return null
    const s = v.trim()
    return s ? s : null
}
function stringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return []
    return v
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map(s => s.trim())
}

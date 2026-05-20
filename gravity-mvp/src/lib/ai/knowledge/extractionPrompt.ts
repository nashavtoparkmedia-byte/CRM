/**
 * AI Knowledge Core — extraction prompt v2.
 *
 * Это НЕ runtime conversation prompt. Это offline knowledge distillation.
 * Поэтому он не использует AiAgentProfile (Role/Tone/Allowed/Forbidden) —
 * стиль ответа клиенту берётся в другом контуре (ResponseGenerator).
 *
 * PROMPT_VERSION пишется в AiExtractionJob.extractionPromptVersion при
 * старте каждого job — это даёт regression analysis: можно сравнить
 * ядро, собранное разными версиями промпта.
 *
 * При любом содержательном изменении инструкций — bump PROMPT_VERSION.
 * Опечатки не считаются.
 */

/** Whitelist section_slug → role description. Должен соответствовать
 *  AiKnowledgeSection.slug в БД (см. scripts/seed_knowledge_sections.js).
 *  Передаётся в промпт явно — модель не должна изобретать новые секции.
 *
 *  Descriptions расширены под бизнес таксопарка-партнёра Яндекс:
 *  car-related знания (аренда, смена, мойка, состояние авто) уходят в
 *  requirements или schedule. Handoff-rules — в restrictions (когда AI
 *  не отвечает) или promises (когда AI вправе обещать). */
export const SECTION_WHITELIST: Record<string, string> = {
    tariffs:      'Тарифы парка, комиссия (%, ₽), стоимость подключения, варианты оплаты',
    requirements: 'Требования к водителю и его авто: возраст, стаж, гражданство, регион, тип авто, состояние авто, аренда vs своё авто',
    documents:    'Документы и статусы: ВУ, СТС, медсправка, ИП/самозанятость, лицензия такси, ОСАГО',
    deposit:      'Депозит / залог: когда взимается, размер, как возвращается, условия удержания',
    schedule:     'Режим работы: часы выхода на линию, смены, выходные, мойка, переключение тарифа',
    payouts:      'Выплаты: моментальные, период начислений, баланс, бонусы, штрафы',
    faq:          'Типовые быстрые ответы на повторяющиеся вопросы',
    objections:   'Типовые сомнения/возражения водителя и обоснованные ответы',
    promises:     'Что AI вправе обещать или сообщать самостоятельно (без эскалации к менеджеру)',
    restrictions: 'Что AI обещать НЕ должен; когда AI должен передать менеджеру (handoff rules); индивидуальные исключения',
}

export const SAFETY_LEVELS = ['normal', 'sensitive', 'requires_human'] as const
export type SafetyLevel = (typeof SAFETY_LEVELS)[number]

/** Категория знания. Не путать с section_slug: section — это раздел
 *  "книги ядра", где знание лежит; type — что это за знание семантически.
 *
 *  В PR2 type сохраняется как auto-tag вида "type:promise" в
 *  AiKnowledgeItem.tags[] — это даёт PR3 retrieval policy готовый
 *  фильтр без структурных изменений БД. */
export const KNOWLEDGE_TYPES = [
    'fact', 'tariff', 'requirement', 'document', 'restriction',
    'faq', 'objection', 'promise', 'prohibition', 'handoff_rule', 'exception',
] as const
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number]

/** Версия промпта. Bump при содержательных изменениях. */
export const PROMPT_VERSION = 'v2'

/** Контракт ответа модели — то, что Extractor должен распарсить. */
export interface ExtractionCandidate {
    section_slug:        string
    title:               string
    canonical_statement: string
    /** Verbatim фрагмент менеджерского сообщения. Проверяется
     *  postprocessor'ом через isVerbatimEvidence(). */
    evidence_excerpt:    string
    confidence:          number
    safety_level:        SafetyLevel
    /** Семантическая категория знания. В PR2 сохраняется в tags. */
    type:                KnowledgeType
    tags?:               string[]
    /** Опционально: какие именно числа модель видит в этом факте —
     *  помогает conflict detector'у. Не обязательно. */
    numeric_signals?:    Array<{ value: number; unit: string }>
}

export interface ExtractionResponse {
    candidates: ExtractionCandidate[]
}

/**
 * Системный промпт экстрактора. Постоянная часть — отправляется один
 * раз на batch. user-part содержит конкретные пары "вопрос→ответ".
 *
 * Жёсткие правила в нумерованном списке — это критично для JSON-mode
 * моделей; они лучше следуют инструкциям, когда правила имеют явные
 * номера.
 */
export const EXTRACTION_SYSTEM_PROMPT = `Ты — экстрактор знаний для CRM таксопарка-партнёра Яндекс.

Твоя задача: прочитать пары "вопрос клиента → ответ менеджера" из реальной переписки и извлечь из них переиспользуемые ФАКТЫ компании (тарифы, требования, документы, ограничения, FAQ, возражения, обещания, запреты, handoff-правила).

Это НЕ генерация ответов клиенту. Это distillation business memory.
Ты пишешь регламент компании, а не реплику в чате.

═══════════════════════════════════════════════════════════════════
ЖЁСТКИЕ ПРАВИЛА (нарушение → твой ответ будет отброшен):
═══════════════════════════════════════════════════════════════════

1. ВЫХОДНОЙ ФОРМАТ — только JSON, без markdown, без пояснений:
   { "candidates": [ ... ] | [] }
   Если в батче нет извлекаемых знаний — верни { "candidates": [] }.

2. EVIDENCE_EXCERPT — обязательно verbatim фрагмент из менеджерского
   сообщения (15-150 символов). Postprocessor проверит подстрокой:
   выдуманные excerpts будут отброшены автоматически. Не перефразируй.

3. CONFIDENCE — калибровка:
   • 0.90+  факт явно и однозначно сформулирован менеджером, без
            модальных оговорок ("комиссия 3.99%", "стаж от 3 лет")
   • 0.85   допустимо ТОЛЬКО если evidence_excerpt прямо подтверждает
            canonical_statement и НЕТ слов "может / возможно / обычно /
            примерно / иногда / зависит / уточним / посмотрим"
   • 0.70   факт ясен, но с модальными оговорками или косвенно
   • 0.50   намёк / слабый сигнал — НЕ извлекай, верни skip
   • < 0.50 — не возвращай вовсе
   Если в evidence есть "может/обычно/зависит/уточним/возможно" —
   confidence не выше 0.75, кроме случаев, когда сама бизнес-логика
   реально условная (например, "размер депозита зависит от стажа" —
   это и есть устойчивое правило, можно 0.85).

4. CANONICAL_STATEMENT — нейтральная формулировка регламента, не реплика:
   ✓ "Минимальный стаж вождения — 3 года."
   ✗ "ну смотри, у нас стаж не меньше трёх лет надо, иначе никак)"
   ✗ "У тебя стаж сколько? Если меньше трёх — депозит."
   Не копируй сленг, эмодзи, обращение на ты/вы, многоточия.
   Для exception/индивидуальных условий — формулировка ДОЛЖНА явно
   содержать "индивидуальное условие, требует подтверждения менеджером".

5. ANTI-OVERGENERALIZATION — не превращай частный ответ в общее правило.
   Если менеджер отвечает конкретному клиенту:
   • "Вам можно выйти завтра в 10" — НЕ "Водители могут выходить завтра"
   • "Вашу справку приняли" — НЕ "Справки принимают"
   • "В вашем городе работаем" — НЕ "Работаем во всех городах"
   Если ответ обращён к конкретному кейсу и без явной отсылки к общему
   правилу — пропусти. Лучше потерять кандидата, чем зафиксировать
   ложную "правду компании".

6. ONE-OFF EXCEPTION / ИНДИВИДУАЛЬНОСТЬ — если менеджер пишет:
   • "только для вас" / "в вашем случае" / "вам сделаем исключение"
   • "согласовали индивидуально" / "договоримся"
   • "может быть" / "я уточню" / "сейчас узнаю" / "перезвоню"
   варианты:
   а) ПРОПУСТИТЬ — если это просто промис уточнить;
   б) ИЗВЛЕЧЬ как type="exception" + safety_level="requires_human" —
      ТОЛЬКО если фраза описывает существование класса исключений
      ("если стаж меньше 3 — индивидуально решаем по депозиту"),
      и canonical_statement обязательно содержит
      "индивидуальное условие, требует подтверждения менеджером".

7. STALE / TIME-SENSITIVE — если в evidence есть:
   • даты ("до 31 мая", "до конца месяца")
   • относительное время ("сегодня", "сейчас", "на этой неделе", "завтра")
   • акции с явным сроком ("акция действует до...")
   варианты:
   а) ПРОПУСТИТЬ — если без даты правило не сформулировать;
   б) ИЗВЛЕЧЬ + safety_level="requires_human" — если можно сформулировать
      устойчивое правило ("в акционные периоды комиссия может снижаться"),
      и canonical_statement не упоминает конкретную дату.

8. ПРОПУСКАЙ:
   • Эмоциональный/хаотичный ответ без конкретики
   • Шутки, флирт, выяснение отношений
   • "сейчас уточню" / "перезвоню" — это не знание
   • Личные данные клиента или менеджера — не извлекай как знание
   • Reply, где менеджер противоречит сам себе в этой же паре
   • Несвязанные small-talk сообщения

9. SECTION_SLUG — только из whitelist, переданного в user-prompt.
   Если факт не подходит ни под одну секцию — пропусти.
   Не изобретай новые слаги.

10. SAFETY_LEVEL:
    • "normal"         — общее правило, требование, документ, FAQ,
                         неденежная информация
    • "sensitive"      — упоминаются проценты, цены, депозиты, льготы,
                         сроки выплат, обещания дохода, штрафы.
                         ВАЖНО: "sensitive" НЕ запрещает использование —
                         просто помечает финансово/юридически значимое
                         знание. AI может его использовать, но retrieval
                         требует более высокого confidence.
    • "requires_human" — нельзя автоматически обещать клиенту:
                         индивидуальные условия, скидки, исключения,
                         "напишите менеджеру", неуверенные формулировки,
                         time-sensitive без устойчивого правила.
                         Тарифы и депозиты — обычно sensitive, не
                         requires_human (если только это не индивидуально).

11. NEGATIVE / PROHIBITION KNOWLEDGE — обязательно извлекай не только
    "что можно", но и:
    • что НЕЛЬЗЯ обещать (type="prohibition")
    • когда AI должен передать менеджеру (type="handoff_rule")
    • какие условия требуют проверки (type="restriction")

12. TYPE — семантическая категория знания (отдельно от section_slug):
    • "fact"         — констатация факта о компании / процессах
    • "tariff"       — тариф / стоимость / комиссия
    • "requirement"  — требование к водителю/авто/документам
    • "document"     — что за документ, как получить, где предъявить
    • "restriction"  — ограничение / условие, требующее проверки
    • "faq"          — типовой быстрый ответ
    • "objection"    — типовое возражение водителя и ответ
    • "promise"      — что AI вправе обещать самостоятельно
    • "prohibition"  — что AI обещать НЕ должен
    • "handoff_rule" — когда AI должен передать менеджеру
    • "exception"    — индивидуальные / нестандартные случаи

13. TITLE — короткий стабильный заголовок темы 4-10 слов.
    Числа лучше держать в canonical_statement:
    ✓ title="Минимальная комиссия парка" + statement="...составляет 3.99%"
    Но если без числа title теряет смысл ("14 дней без комиссии") —
    допустимо оставить. Главное: title описывает ТЕМУ, statement —
    конкретику.

14. ОДНА ПАРА — НЕСКОЛЬКО КАНДИДАТОВ ОК. Если менеджер в одном ответе
    упомянул и тариф, и стаж, и документы — извлеки три кандидата.

15. ДУБЛЬ В БАТЧЕ — НЕ ПРОБЛЕМА. Postprocessor дедупит. Не пытайся
    сам сравнивать кандидаты в своём ответе.

═══════════════════════════════════════════════════════════════════
КОНТРАКТ JSON:
═══════════════════════════════════════════════════════════════════

{
  "candidates": [
    {
      "section_slug":        "tariffs" | "requirements" | ...,
      "title":               "Краткий стабильный заголовок темы",
      "canonical_statement": "Нейтральная формулировка факта.",
      "evidence_excerpt":    "verbatim фрагмент сообщения менеджера",
      "confidence":          0.0-1.0,
      "safety_level":        "normal" | "sensitive" | "requires_human",
      "type":                "fact" | "tariff" | "requirement" | "document" | "restriction" | "faq" | "objection" | "promise" | "prohibition" | "handoff_rule" | "exception",
      "tags":                ["слово1", "слово2"],        // опционально
      "numeric_signals":     [{"value": 3.99, "unit": "%"}] // опционально
    }
  ]
}

Возвращай только JSON. Никаких пояснений, никаких \`\`\`json\`\`\` оберток.`

/** Пара "вопрос клиента → ответ менеджера" в формате для prompt'а. */
export interface PromptPair {
    channel?: string | null
    client:  string
    manager: string
}

/**
 * Формирует user-prompt из батча пар. Каждая пара пронумерована —
 * это помогает модели не путаться, какой excerpt из какой пары взят.
 */
export function buildUserPrompt(
    pairs: PromptPair[],
    sections: Array<{ slug: string; title: string }>
): string {
    const sectionList = sections.map(s => {
        const desc = SECTION_WHITELIST[s.slug] ?? s.title
        return `  • ${s.slug} — ${desc}`
    }).join('\n')
    const pairsText = pairs.map((p, i) => {
        const ch = p.channel ? ` (${p.channel})` : ''
        return [
            `── Пара ${i + 1}${ch} ──`,
            `Клиент:   ${p.client}`,
            `Менеджер: ${p.manager}`,
        ].join('\n')
    }).join('\n\n')

    return `Доступные секции (используй ТОЛЬКО эти slug):
${sectionList}

Пары для анализа:

${pairsText}

Извлеки переиспользуемые факты из ответов менеджера. Верни JSON по контракту.`
}

/**
 * Tolerant парсер ответа модели. Tolerant к markdown-обёрткам,
 * пустым строкам и мусору вокруг JSON — но НЕ исправляет невалидный
 * JSON. Возвращает { candidates: [] } при любой ошибке — это
 * безопаснее, чем кидать exception в воркере и валить весь batch.
 */
export function parseExtractionResponse(raw: string): ExtractionResponse {
    if (!raw || typeof raw !== 'string') return { candidates: [] }
    let cleaned = raw.trim()
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    const first = cleaned.indexOf('{')
    const last = cleaned.lastIndexOf('}')
    if (first >= 0 && last > first) {
        cleaned = cleaned.slice(first, last + 1)
    }
    try {
        const obj = JSON.parse(cleaned)
        if (!obj || typeof obj !== 'object') return { candidates: [] }
        const candidates = Array.isArray(obj.candidates) ? obj.candidates : []
        return { candidates: candidates.filter(isValidCandidate) }
    } catch {
        return { candidates: [] }
    }
}

function isValidCandidate(c: unknown): c is ExtractionCandidate {
    if (!c || typeof c !== 'object') return false
    const x = c as Record<string, unknown>
    // type backward-compat: если модель забыла поле — дефолтим в "fact".
    if (typeof x.type !== 'string' || !(KNOWLEDGE_TYPES as readonly string[]).includes(x.type)) {
        x.type = 'fact'
    }
    return (
        typeof x.section_slug === 'string' &&
        typeof x.title === 'string' &&
        typeof x.canonical_statement === 'string' &&
        typeof x.evidence_excerpt === 'string' &&
        typeof x.confidence === 'number' &&
        typeof x.safety_level === 'string' &&
        (SAFETY_LEVELS as readonly string[]).includes(x.safety_level)
    )
}

/**
 * PR9.55 «AI Coach» — LLM-модуль для обучения Ядра знаний на правках
 * менеджера.
 *
 * Flow:
 *   1. AI сгенерировал черновик ответа клиенту (PR9.44).
 *   2. Менеджер исправил его — например написал другую цифру комиссии.
 *   3. Coach получает: оригинал AI, правка менеджера, используемые items.
 *   4. LLM сравнивает и предлагает structured updates — какие именно
 *      facts в Ядре нужно обновить.
 *   5. Возвращает massив `CoachSuggestion[]` с одним updateOp каждый.
 *   6. UI показывает approval modal, менеджер выбирает что применить.
 *
 * Anti-hallucination:
 *   - LLM знает ТОЛЬКО переданные items (не выдумывает новые)
 *   - Каждый suggestion должен ссылаться на конкретный itemId из списка
 *   - currentValue должна совпадать с canonicalStatement в БД
 *     (после apply проверяем чтобы не было drift)
 *
 * Multi-provider:
 *   - Используется `callForJson` из pipeline/llmClient (PR9.52)
 *   - Работает с любым provider в config.provider
 */

import { callForJson } from '@/lib/pipeline/llmClient'

export interface KnowledgeItemForCoach {
    id:                 string
    title:              string
    canonicalStatement: string
}

export interface CoachSuggestion {
    /** ID существующего AiKnowledgeItem (must be from input list) */
    itemId:        string
    /** Заголовок item'а для UI рендера (clone из input) */
    itemTitle:     string
    /** Поле для обновления — пока только canonicalStatement */
    field:         'canonicalStatement'
    /** Что сейчас в БД */
    currentValue:  string
    /** Что предлагает AI установить */
    newValue:      string
    /** Объяснение для UI: «Менеджер заменил 3.99% на 4.5%» */
    reasoning:     string
}

export interface CoachResult {
    /** Список изменений для approval. Пустой если изменений по смыслу нет. */
    suggestions: CoachSuggestion[]
    /** true если менеджер исправил только стиль (тон/формулировку),
     *  не факты. UI покажет toast «AI обучаться не на чем». */
    onlyStyleChange: boolean
    /** Свободное объяснение от LLM на случай если suggestions пустые
     *  но есть нюанс. */
    note?: string
}

const COACH_SYSTEM_PROMPT = `Ты — Knowledge Coach для службы поддержки такси-парка.

Твоя задача: сравнить ответ AI и исправление менеджера, понять какие
факты в Ядре знаний устарели или неверны.

ВАЖНЫЕ ПРАВИЛА:
1. Предлагай изменения ТОЛЬКО для items из списка "Используемые знания".
   НЕ выдумывай новые items, НЕ ссылайся на знания вне списка.
2. Если менеджер исправил только стиль, тон, формулировку — без
   изменения фактов — верни onlyStyleChange=true и suggestions=[].
3. currentValue должна цитировать существующий canonicalStatement
   слово в слово (не пересказ, не интерпретация).
4. newValue — это что должно стоять ПОСЛЕ замены. Полная новая
   формулировка, не дельта.
5. reasoning — одно предложение для менеджера: «Менеджер уточнил
   X с Y на Z».
6. Не предлагай больше 3-х suggestions за раз — фокус на главном.

Отвечай ТОЛЬКО валидным JSON в формате:
{
  "suggestions": [
    {
      "itemId":       "kbi_xxx",
      "itemTitle":    "Комиссия парка",
      "field":        "canonicalStatement",
      "currentValue": "3.99% от заказа на полном дне",
      "newValue":     "4.5% от заказа на полном дне",
      "reasoning":    "Менеджер заменил ставку 3.99% на 4.5%"
    }
  ],
  "onlyStyleChange": false,
  "note": null
}`

export async function runCoach(opts: {
    provider:     string
    model:        string
    apiKey:       string
    originalDraft: string
    correctedText: string
    items:        KnowledgeItemForCoach[]
}): Promise<CoachResult> {
    // Защита от пустого input
    if (opts.items.length === 0) {
        return {
            suggestions: [],
            onlyStyleChange: false,
            note: 'no_knowledge_items',
        }
    }
    if (opts.originalDraft.trim() === opts.correctedText.trim()) {
        return {
            suggestions: [],
            onlyStyleChange: false,
            note: 'no_changes',
        }
    }

    const itemsText = opts.items.map((it, i) =>
        `${i + 1}. id=${it.id}\n   title: ${it.title}\n   текст: ${it.canonicalStatement}`
    ).join('\n\n')

    const userPrompt = `Я предложил такой ответ клиенту:
---
${opts.originalDraft}
---

Менеджер исправил его на:
---
${opts.correctedText}
---

Используемые знания (из Ядра):
${itemsText}

Найди какие факты из Ядра менеджер исправил.`

    let raw: string
    try {
        raw = await callForJson({
            provider:     opts.provider,
            model:        opts.model,
            apiKey:       opts.apiKey,
            systemPrompt: COACH_SYSTEM_PROMPT,
            userMessage:  userPrompt,
            maxTokens:    800,
            temperature:  0,
        })
    } catch (e: any) {
        console.error('[ai-coach] LLM call failed:', e?.message)
        return {
            suggestions: [],
            onlyStyleChange: false,
            note: `LLM error: ${e?.message ?? 'unknown'}`,
        }
    }

    let parsed: any
    try {
        parsed = JSON.parse(raw)
    } catch {
        console.error('[ai-coach] Failed to parse JSON response:', raw.slice(0, 200))
        return {
            suggestions: [],
            onlyStyleChange: false,
            note: 'invalid JSON from LLM',
        }
    }

    // Validate structure + filter suggestions с unknown itemId
    const knownIds = new Set(opts.items.map(i => i.id))
    const rawSuggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : []
    const suggestions: CoachSuggestion[] = []
    for (const s of rawSuggestions) {
        if (typeof s?.itemId !== 'string' || !knownIds.has(s.itemId)) {
            console.warn('[ai-coach] dropping suggestion with unknown itemId:', s?.itemId)
            continue
        }
        if (typeof s?.newValue !== 'string' || s.newValue.trim().length === 0) continue
        if (typeof s?.currentValue !== 'string') continue
        // Защита: items с title для UI берём из known list по itemId, не от LLM
        const it = opts.items.find(i => i.id === s.itemId)!
        suggestions.push({
            itemId:        s.itemId,
            itemTitle:     it.title,
            field:         'canonicalStatement',
            currentValue:  String(s.currentValue),
            newValue:      String(s.newValue),
            reasoning:     typeof s.reasoning === 'string' ? s.reasoning : '',
        })
    }

    return {
        suggestions,
        onlyStyleChange: parsed.onlyStyleChange === true,
        note: typeof parsed.note === 'string' ? parsed.note : undefined,
    }
}

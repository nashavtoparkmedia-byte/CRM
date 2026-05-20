/**
 * AI Knowledge Core — retrieval re-rank prompt (PR3.3).
 *
 * Это НЕ генерация ответа и НЕ retrieval from scratch. Это re-rank:
 * deterministic prefilter уже отобрал top 15-25, LLM выбирает top 3-5.
 * Модель НЕ видит всю базу — только presented candidates.
 *
 * RETRIEVAL_PROMPT_VERSION пишется в AiDecisionLog.knowledgeRuntimeVersion.
 * Bump при содержательных изменениях.
 */

export const RETRIEVAL_PROMPT_VERSION = 'v1'

export interface RerankCandidate {
    id:                 string
    title:              string
    canonicalStatement: string
    verified:           boolean
    sourceCount:        number
    safetyLevel:        'normal' | 'sensitive' | 'requires_human'
}

export interface RerankResponse {
    selectedIds: string[]
    reasoning?:  string
}

export const RERANK_SYSTEM_PROMPT = `Ты — re-ranker для AI-агента таксопарка-партнёра Яндекс.

На входе: вопрос клиента и numbered список candidates (фактов компании).
Твоя задача: выбрать до 5 самых релевантных IDs в порядке убывания.

═══════════════════════════════════════════════════════════════════
ЖЁСТКИЕ ПРАВИЛА:
═══════════════════════════════════════════════════════════════════

1. ВЫХОДНОЙ ФОРМАТ — только JSON:
   { "selectedIds": ["id1", "id2", ...], "reasoning": "..." }
   reasoning опционален. selectedIds обязателен.

2. ВЫБИРАЙ ТОЛЬКО IZ PRESENTED. Не изобретай новые id. Не комбинируй
   несколько фактов в один — выбирай существующие.

3. РЕЛЕВАНТНОСТЬ — главный критерий: factual match с вопросом клиента.
   Косвенные совпадения — пропускай.

4. ПРЕДПОЧИТАЙ VERIFIED. При равной релевантности подтверждённый
   факт идёт выше неподтверждённого.

5. ИЗБЕГАЙ requires_human-фактов. Если есть normal/sensitive с равной
   релевантностью — выбирай его. requires_human даёт policy-layer
   повод эскалировать.

6. ИЗБЕГАЙ КОНФЛИКТОВ. Если два candidate'а явно противоречат
   (разные тарифы для одного вопроса) — выбирай ОДИН (более verified /
   больше sourceCount), второй не включай.

7. ЕСЛИ НИЧЕГО НЕ ПОДХОДИТ — верни пустой массив:
   { "selectedIds": [], "reasoning": "no relevant" }
   Pipeline policy эскалирует ответ менеджеру.

8. БЕЗ МАРКДАУНА. Только raw JSON.

═══════════════════════════════════════════════════════════════════`

export function buildRerankUserPrompt(
    query: string,
    candidates: RerankCandidate[],
): string {
    const listing = candidates.map((c, i) => {
        const v = c.verified ? ' [подтверждено]' : ''
        const sc = c.sourceCount > 0 ? ` (${c.sourceCount} ист.)` : ''
        const lvl = c.safetyLevel === 'requires_human' ? ' [только менеджер]'
                  : c.safetyLevel === 'sensitive'      ? ' [финансовое]'
                  : ''
        return `${i + 1}. id="${c.id}"${v}${sc}${lvl}\n   ${c.title}\n   ${c.canonicalStatement}`
    }).join('\n\n')

    return `Вопрос клиента:
${query}

Кандидаты (фактическая база компании):

${listing}

Выбери до 5 самых релевантных IDs. Верни JSON.`
}

export function parseRerankResponse(raw: string): RerankResponse {
    if (!raw || typeof raw !== 'string') return { selectedIds: [] }
    let cleaned = raw.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim()
    const first = cleaned.indexOf('{')
    const last = cleaned.lastIndexOf('}')
    if (first >= 0 && last > first) {
        cleaned = cleaned.slice(first, last + 1)
    }
    try {
        const obj = JSON.parse(cleaned)
        if (!obj || typeof obj !== 'object') return { selectedIds: [] }
        const ids = Array.isArray(obj.selectedIds) ? obj.selectedIds : []
        const filtered = ids.filter((x: unknown) => typeof x === 'string' && x.length > 0)
        return {
            selectedIds: filtered,
            reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : undefined,
        }
    } catch {
        return { selectedIds: [] }
    }
}

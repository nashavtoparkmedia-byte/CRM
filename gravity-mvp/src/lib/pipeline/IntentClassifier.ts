import { MessageContext } from './ContextBuilder'

export interface ClassificationResult {
  intent: string
  confidence: number
  matchedKbEntryId: string | null
}

export class IntentClassifier {
  async classify(userMessage: string, ctx: MessageContext): Promise<ClassificationResult> {
    const { config, knowledgeBase } = ctx

    if (!config.apiKey) {
      return { intent: 'unknown', confidence: 0, matchedKbEntryId: null }
    }

    const kbText = knowledgeBase.length > 0
      ? knowledgeBase.map(kb =>
          `ID: ${kb.id}\nТема: ${kb.title}\nПримеры вопросов: ${kb.sampleQuestions.join('; ')}`
        ).join('\n---\n')
      : 'База знаний пуста'

    const systemPrompt = `Ты — классификатор намерений для службы поддержки водителей такси.
Язык: ${config.language}.

База знаний:
${kbText}

Задача: определи намерение пользователя и найди подходящую запись в базе знаний.
Отвечай ТОЛЬКО валидным JSON без markdown-блоков:
{"intent":"краткое_описание","confidence":0.0,"matchedKbEntryId":"id_или_null"}`

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      config.classificationModel,
        max_tokens: 200,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userMessage }],
      }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(`Anthropic classify error: ${err?.error?.message || response.status}`)
    }

    const data = await response.json()
    const text = data.content?.[0]?.text || ''

    try {
      const parsed = JSON.parse(text)
      return {
        intent:           String(parsed.intent  || 'unknown'),
        confidence:       typeof parsed.confidence === 'number' ? parsed.confidence : 0,
        matchedKbEntryId: parsed.matchedKbEntryId || null,
      }
    } catch {
      console.warn('[IntentClassifier] Failed to parse JSON:', text)
      return { intent: 'unknown', confidence: 0, matchedKbEntryId: null }
    }
  }
}

export const intentClassifier = new IntentClassifier()

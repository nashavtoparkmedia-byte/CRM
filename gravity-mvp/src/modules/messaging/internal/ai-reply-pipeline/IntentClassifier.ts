import type { MessageContext } from './ContextBuilder'
import { callProviderJsonV1 as callForJson } from '@/infrastructure/providers/multi-provider-llm'

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

    // PR9.52: multi-provider routing через shared provider infrastructure. Раньше всегда
    // шёл в Anthropic — отсюда «invalid x-api-key» при OpenAI provider.
    const text = await callForJson({
      provider:     config.provider,
      model:        config.classificationModel,
      apiKey:       config.apiKey,
      systemPrompt,
      userMessage,
      maxTokens:    200,
      temperature:  0,
    })

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

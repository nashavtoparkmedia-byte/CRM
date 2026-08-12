import type { MessageContext } from './ContextBuilder'
import type { ClassificationResult } from './IntentClassifier'
import type { DecisionResult } from './DecisionEngine'
import { channelRegistry } from './ChannelAdapterRegistry'
import { formatKnowledgeFactsForPromptV1 } from '@/modules/ai-knowledge/public/v1/knowledge-retrieval'
import { callProviderTextV1 as callForText } from '@/infrastructure/providers/multi-provider-llm'

export interface GeneratedResponse {
  reply: string | null
  sent: boolean
}

export class ResponseGenerator {
  async generate(
    ctx: MessageContext,
    classification: ClassificationResult,
    decision: DecisionResult,
  ): Promise<GeneratedResponse> {
    if (decision.decision === 'skip' || !ctx.config.apiKey) {
      return { reply: null, sent: false }
    }

    const { config, chat, driver, recentMessages, knowledgeBase, knowledgeRetrieval } = ctx

    // PR3 runtime-mode: ТОЛЬКО canonical facts из Knowledge Core.
    // Legacy KB dump игнорируется. Без excerpts, без raw chat.
    const useRuntimeKnowledge = knowledgeRetrieval?.mode === 'runtime'

    // Legacy путь: matchedKb из KnowledgeBaseEntry (shadow / null → legacy).
    const matchedKb = !useRuntimeKnowledge && classification.matchedKbEntryId
      ? knowledgeBase.find(kb => kb.id === classification.matchedKbEntryId)
      : null

    // Build system prompt from config fields
    const parts: string[] = []
    parts.push(config.promptRole || 'Ты — помощник службы поддержки водителей такси.')
    if (config.promptTone)      parts.push(`Тон общения: ${config.promptTone}.`)
    if (config.promptAllowed)   parts.push(`Разрешено: ${config.promptAllowed}.`)
    if (config.promptForbidden) parts.push(`Запрещено: ${config.promptForbidden}.`)
    parts.push(`Язык ответа: ${config.language}. Отвечай кратко и по делу.`)
    if (driver?.fullName) parts.push(`Водитель: ${driver.fullName}.`)
    if (useRuntimeKnowledge) {
      // PR3 runtime: ТОЛЬКО canonical facts. Никаких raw excerpts.
      // Жёсткая инструкция использовать только переданное и эскалировать
      // иначе — вся защита от галлюцинаций.
      parts.push(
        '\nИспользуй ТОЛЬКО следующие подтверждённые факты компании. ' +
        'Если фактов недостаточно или они противоречат вопросу клиента — ' +
        'честно скажи, что передашь вопрос менеджеру.\n' +
        formatKnowledgeFactsForPromptV1(knowledgeRetrieval!.items),
      )
    } else if (matchedKb) {
      parts.push(`\nСправочная информация по теме "${matchedKb.title}":\n${matchedKb.answer}`)
    }

    const systemPrompt = parts.join(' ')

    // PR9.52: multi-provider routing через shared provider infrastructure. Раньше всегда
    // шёл в Anthropic — для OpenAI пользователей возвращало
    // «invalid x-api-key».
    const reply = await callForText({
      provider:     config.provider,
      model:        config.responseModel,
      apiKey:       config.apiKey!,
      systemPrompt,
      messages:     recentMessages,
      maxTokens:    500,
      temperature:  0.3,
    })
    if (!reply) return { reply: null, sent: false }

    // Send only in auto_reply mode (not suggest_only — that's just a suggestion)
    const shouldSend = decision.decision === 'auto_reply' && config.mode === 'auto_reply'

    if (shouldSend && channelRegistry.has(chat.channel)) {
      await channelRegistry.send(chat.channel, {
        chatId:         chat.id,
        externalChatId: chat.externalChatId,
        content:        reply,
        channel:        chat.channel,
      })
    }

    return { reply, sent: shouldSend }
  }
}

export const responseGenerator = new ResponseGenerator()

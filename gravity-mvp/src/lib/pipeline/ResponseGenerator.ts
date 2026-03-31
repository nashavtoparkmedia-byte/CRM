import { MessageContext } from './ContextBuilder'
import { ClassificationResult } from './IntentClassifier'
import { DecisionResult } from './DecisionEngine'
import { channelRegistry } from './ChannelAdapterRegistry'

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

    const { config, chat, driver, recentMessages, knowledgeBase } = ctx

    // Find matched KB entry for grounding
    const matchedKb = classification.matchedKbEntryId
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
    if (matchedKb) {
      parts.push(`\nСправочная информация по теме "${matchedKb.title}":\n${matchedKb.answer}`)
    }

    const systemPrompt = parts.join(' ')

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         config.apiKey!,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      config.responseModel,
        max_tokens: 500,
        system:     systemPrompt,
        messages:   recentMessages,
      }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(`Anthropic response error: ${err?.error?.message || response.status}`)
    }

    const data = await response.json()
    const reply = data.content?.[0]?.text?.trim() || ''
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

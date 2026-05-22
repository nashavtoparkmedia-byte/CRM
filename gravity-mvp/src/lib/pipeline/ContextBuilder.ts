import { prisma } from '@/lib/prisma'
import { Message } from '@prisma/client'
import { retrieve, type RetrievalTrace, type RetrievableItem } from '@/lib/ai/knowledge/Retriever'
import { getKnowledgeRuntimeMode } from '@/lib/ai/knowledge/featureFlags'

export interface AiConfig {
  enabled: boolean
  mode: string
  provider: string
  apiKey: string | null
  classificationModel: string
  responseModel: string
  language: string
  confidenceThreshold: number
  maxAutoRepliesPerChat: number
  activeChannels: string[]
  promptRole: string | null
  promptTone: string | null
  promptAllowed: string | null
  promptForbidden: string | null
}

export interface KbEntry {
  id: string
  title: string
  category: string
  sampleQuestions: string[]
  answer: string
  priority: number
}

/**
 * PR3: результат retrieval pipeline. null если retrieval disabled
 * (mode=legacy) или если вызов retrieve() упал. Pipeline в обоих
 * случаях продолжает работать на legacy KnowledgeBaseEntry.
 */
export interface KnowledgeRetrievalResult {
  /** 'shadow' = trace пишется, ответ из legacy. 'runtime' = ответ из retrieved facts. */
  mode:  'shadow' | 'runtime'
  items: RetrievableItem[]
  trace: RetrievalTrace
}

export interface MessageContext {
  config: AiConfig
  chat: { id: string; channel: string; externalChatId: string; driverId: string | null }
  driver: { fullName: string | null; phone: string | null } | null
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>
  knowledgeBase: KbEntry[]
  /** PR3: retrieval result. null если retrieval disabled или упал —
   *  ResponseGenerator в этом случае работает на legacy knowledgeBase. */
  knowledgeRetrieval: KnowledgeRetrievalResult | null
}

export class ContextBuilder {
  /**
   * Build context для AI pipeline.
   *
   * @param message — inbound message который будем обрабатывать
   * @param opts.ignoreModeOff — если true, не блокируем при `config.mode='off'`.
   *   Используется в shadowReply (PR9.44 «AI стажёр»): даже если глобально
   *   AI выключен (mode='off'), стажёр должен генерировать черновики
   *   для менеджера — они не отправляются реально, это просто подсказки.
   *   Проверка `enabled=false` сохраняется (это полный disable, без него
   *   не настроено даже AI-юзеры).
   */
  async build(message: Message, opts?: { ignoreModeOff?: boolean }): Promise<MessageContext | null> {
    // Load AI config
    const rows = await prisma.$queryRaw<any[]>`SELECT * FROM "AiAgentConfig" WHERE id = 'singleton' LIMIT 1`
    if (!rows[0]) return null
    const raw = rows[0]

    const config: AiConfig = {
      enabled:              raw.enabled,
      mode:                 raw.mode,
      provider:             raw.provider,
      apiKey:               raw.apiKeyEncrypted ?? null,
      classificationModel:  raw.classificationModel || 'claude-haiku-4-5',
      responseModel:        raw.responseModel || 'claude-sonnet-4-5',
      language:             raw.language || 'ru',
      confidenceThreshold:  raw.confidenceThreshold ?? 0.75,
      maxAutoRepliesPerChat: raw.maxAutoRepliesPerChat ?? 5,
      activeChannels:       raw.activeChannels || [],
      promptRole:           raw.promptRole ?? null,
      promptTone:           raw.promptTone ?? null,
      promptAllowed:        raw.promptAllowed ?? null,
      promptForbidden:      raw.promptForbidden ?? null,
    }

    if (!config.enabled) return null
    if (config.mode === 'off' && !opts?.ignoreModeOff) return null

    // Load chat
    const chat = await prisma.chat.findUnique({
      where:  { id: message.chatId },
      select: { id: true, channel: true, externalChatId: true, driverId: true },
    })
    if (!chat) return null

    // Load driver
    let driver: { fullName: string | null; phone: string | null } | null = null
    if (chat.driverId) {
      const d = await prisma.driver.findUnique({
        where:  { id: chat.driverId },
        select: { fullName: true, phone: true },
      })
      driver = d ? { fullName: d.fullName, phone: d.phone } : null
    }

    // Load recent messages (last 20, chronological)
    const msgs = await prisma.message.findMany({
      where:   { chatId: message.chatId },
      orderBy: { createdAt: 'desc' },
      take:    20,
      select:  { direction: true, content: true },
    })
    const recentMessages = msgs
      .reverse()
      .filter(m => m.content?.trim())
      .map(m => ({
        role:    m.direction === 'inbound' ? 'user' as const : 'assistant' as const,
        content: m.content,
      }))

    // Load knowledge base (active, top priority)
    const kbRows = await prisma.$queryRaw<any[]>`
      SELECT id, title, category, "sampleQuestions", answer, priority
      FROM "KnowledgeBaseEntry"
      WHERE active = true
      ORDER BY priority DESC
      LIMIT 20
    `
    const knowledgeBase: KbEntry[] = kbRows.map(r => ({
      id:              r.id,
      title:           r.title,
      category:        r.category,
      sampleQuestions: Array.isArray(r.sampleQuestions) ? r.sampleQuestions : [],
      answer:          r.answer,
      priority:        r.priority,
    }))

    // ─── PR3: AI Knowledge Core retrieval (shadow / runtime) ─────
    //
    // Mode определяется env-флагами:
    //   - 'legacy'  → retrieval skip (нулевое влияние)
    //   - 'shadow'  → retrieve работает, trace пишется PipelineWorker'ом,
    //                 но ответ всё ещё из legacy knowledgeBase
    //   - 'runtime' → retrieve работает, ResponseGenerator получает items
    //                 как single source of truth
    //
    // Tolerant: failure retrieve() не валит main pipeline —
    // knowledgeRetrieval=null, и ResponseGenerator работает на legacy KB.
    let knowledgeRetrieval: KnowledgeRetrievalResult | null = null
    const mode = getKnowledgeRuntimeMode()
    if (mode !== 'legacy') {
      const lastInbound = recentMessages.slice().reverse().find(m => m.role === 'user')
      const query = lastInbound?.content ?? message.content ?? ''
      if (query.trim().length > 0) {
        try {
          const result = await retrieve({
            query,
            recentMessages,
            shadowMode: mode === 'shadow',
          })
          knowledgeRetrieval = {
            mode:  mode === 'runtime' ? 'runtime' : 'shadow',
            items: result.items,
            trace: result.trace,
          }
        } catch (e: any) {
          if (process.env.NODE_ENV !== 'production') {
            console.error('[contextBuilder] retrieve failed:', e?.message)
          }
          knowledgeRetrieval = null
        }
      }
    }

    return { config, chat, driver, recentMessages, knowledgeBase, knowledgeRetrieval }
  }
}

export const contextBuilder = new ContextBuilder()

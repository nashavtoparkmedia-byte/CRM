import { prisma } from '@/lib/prisma'
import { Message } from '@prisma/client'

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

export interface MessageContext {
  config: AiConfig
  chat: { id: string; channel: string; externalChatId: string; driverId: string | null }
  driver: { fullName: string | null; phone: string | null } | null
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>
  knowledgeBase: KbEntry[]
}

export class ContextBuilder {
  async build(message: Message): Promise<MessageContext | null> {
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

    if (!config.enabled || config.mode === 'off') return null

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

    return { config, chat, driver, recentMessages, knowledgeBase }
  }
}

export const contextBuilder = new ContextBuilder()

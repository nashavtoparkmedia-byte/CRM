import { Message } from '@prisma/client'
import { setAiStatus } from '@/lib/messageEvents'
import { prisma } from '@/lib/prisma'
import { contextBuilder } from './ContextBuilder'
import { intentClassifier } from './IntentClassifier'
import { decisionEngine, DecisionResult } from './DecisionEngine'
import { responseGenerator } from './ResponseGenerator'

/**
 * PipelineWorker — обрабатывает входящие сообщения через очередь MessageEventLog.
 *
 * Статусная модель:
 *   MessageEventLog: pending → processing → processed | failed
 *   Message.aiStatus: pending → processing → done | failed
 *
 * AI pipeline (Block 4):
 *   ContextBuilder → IntentClassifier → DecisionEngine → ResponseGenerator → AiDecisionLog
 */
export class PipelineWorker {

  async process(message: Message): Promise<void> {
    // Только входящие сообщения идут в AI-ветку
    if (message.direction !== 'inbound') {
      await setAiStatus(message.id, 'skipped')
      return
    }

    // Атомарный захват: UPDATE WHERE status='pending' → 'processing'
    const result = await prisma.$executeRaw`
      UPDATE "MessageEventLog"
      SET status = 'processing', "updatedAt" = NOW()
      WHERE "messageId" = ${message.id}
        AND "eventType" = 'MessageReceived'
        AND status = 'pending'
    `

    if (result === 0) {
      console.log(`[Pipeline] Already claimed or missing event: msg=${message.id}`)
      return
    }

    try {
      await setAiStatus(message.id, 'processing')
      console.log(`[Pipeline] Processing msg=${message.id}`)

      await this._runSteps(message)

      await prisma.$executeRaw`
        UPDATE "MessageEventLog"
        SET status = 'processed', "updatedAt" = NOW()
        WHERE "messageId" = ${message.id}
          AND "eventType" = 'MessageReceived'
          AND status = 'processing'
      `
      await setAiStatus(message.id, 'done')
      console.log(`[Pipeline] Done msg=${message.id}`)
    } catch (e: any) {
      console.error(`[Pipeline] Failed msg=${message.id}:`, e.message)
      await prisma.$executeRaw`
        UPDATE "MessageEventLog"
        SET status = 'failed', "updatedAt" = NOW()
        WHERE "messageId" = ${message.id}
          AND "eventType" = 'MessageReceived'
          AND status = 'processing'
      `.catch(() => {})
      await setAiStatus(message.id, 'failed').catch(() => {})
    }
  }

  private async _runSteps(message: Message): Promise<void> {
    // Step 1: Build context (loads config, chat, driver, KB)
    const ctx = await contextBuilder.build(message)

    if (!ctx) {
      console.log(`[Pipeline] AI disabled/off for msg=${message.id}, skipping`)
      return
    }

    const userMessage = message.content?.trim() || ''
    if (!userMessage) {
      console.log(`[Pipeline] Empty content, skipping AI for msg=${message.id}`)
      return
    }

    let classification = { intent: 'unknown', confidence: 0, matchedKbEntryId: null as string | null }
    let decision: DecisionResult = { decision: 'skip', reason: 'init' }
    let generatedReply: string | null = null
    let replySent      = false
    let error: string | null = null

    try {
      // Step 2: Classify intent
      classification = await intentClassifier.classify(userMessage, ctx)
      console.log(`[Pipeline] Intent="${classification.intent}" conf=${classification.confidence} msg=${message.id}`)

      // Step 3: Decide action
      decision = await decisionEngine.decide(classification, ctx)
      console.log(`[Pipeline] Decision="${decision.decision}" (${decision.reason}) msg=${message.id}`)

      // Step 4: Generate and optionally send response
      if (decision.decision !== 'skip') {
        const generated = await responseGenerator.generate(ctx, classification, decision)
        generatedReply  = generated.reply
        replySent       = generated.sent
        console.log(`[Pipeline] Reply generated, sent=${replySent} msg=${message.id}`)
      }
    } catch (e: any) {
      error = e.message
      console.error(`[Pipeline] AI step error msg=${message.id}:`, error)
    }

    // Write to AiDecisionLog
    const logId = `adl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    const usedKb = classification.matchedKbEntryId
      ? JSON.stringify([classification.matchedKbEntryId])
      : '[]'

    await prisma.$executeRaw`
      INSERT INTO "AiDecisionLog" (
        id, "messageId", "chatId", channel,
        "detectedIntent", confidence, decision, "selectedModel",
        "usedKnowledgeEntries", "generatedReply", "replySent", escalated, error,
        "createdAt"
      ) VALUES (
        ${logId},
        ${message.id},
        ${ctx.chat.id},
        ${ctx.chat.channel},
        ${classification.intent},
        ${classification.confidence},
        ${decision.decision},
        ${decision.decision === 'auto_reply' ? ctx.config.responseModel : ctx.config.classificationModel},
        ${usedKb}::jsonb,
        ${generatedReply},
        ${replySent},
        ${decision.decision === 'escalate'},
        ${error},
        NOW()
      )
    `.catch(e => console.error('[Pipeline] AiDecisionLog write error:', e.message))
  }
}

// Singleton — один экземпляр на весь процесс Next.js
export const pipelineWorker = new PipelineWorker()

import { Message } from '@prisma/client'
import { setAiStatus } from '@/lib/messageEvents'
import { prisma } from '@/lib/prisma'
import { contextBuilder } from './ContextBuilder'
import { intentClassifier } from './IntentClassifier'
import { decisionEngine, DecisionResult } from './DecisionEngine'
import { responseGenerator } from './ResponseGenerator'
import { RETRIEVAL_PROMPT_VERSION } from '@/lib/ai/knowledge/retrievalPrompt'
import type { KnowledgeRetrievalResult } from './ContextBuilder'
import { RECORD_KNOWLEDGE_USAGE_COMMAND_V1 } from '@/contracts/ai-knowledge/v1'
import { recordKnowledgeUsageV1 } from '@/modules/ai-knowledge/public/v1'

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

    // PR3 retrieval state.
    let retrievalMode:    string | null = null
    let retrievalDecision: string | null = null
    let escalationReason: string | null = null
    let runtimeVersion:   string | null = null
    let shadowSummary:    string | null = null

    try {
      // Step 2: Classify intent
      classification = await intentClassifier.classify(userMessage, ctx)
      console.log(`[Pipeline] Intent="${classification.intent}" conf=${classification.confidence} msg=${message.id}`)

      // Step 3: Decide action
      decision = await decisionEngine.decide(classification, ctx)
      console.log(`[Pipeline] Decision="${decision.decision}" (${decision.reason}) msg=${message.id}`)

      // ─── PR3: retrieval policy override в runtime mode ────────
      //
      // Если retriever работал в runtime mode и policy решил escalate
      // (conflict / requires_human / low_confidence / etc) — override
      // decision на 'escalate' и не вызываем generator. AI не должен
      // сам "склеить" что-то из неполных/опасных знаний.
      //
      // В shadow mode override не делаем — ответ продолжает идти из
      // legacy KB, policy decision пишется в trace для compare.
      const kr = ctx.knowledgeRetrieval
      if (kr) {
        retrievalMode     = kr.mode
        retrievalDecision = kr.trace.policy.type
        escalationReason  = kr.trace.policy.escalationReason
        runtimeVersion    = `rerank:${RETRIEVAL_PROMPT_VERSION} policy:${kr.trace.policyVersion}`
        if (kr.mode === 'shadow') {
          shadowSummary = JSON.stringify({
            decision:         kr.trace.policy.type,
            escalationReason: kr.trace.policy.escalationReason,
            topItemIds:       kr.items.map(i => i.id).slice(0, 5),
            candidateCount:   kr.trace.candidates.length,
            durationMs:       kr.trace.durationMs,
          })
        }
        if (kr.mode === 'runtime' && kr.trace.policy.type !== 'answer') {
          console.log(`[Pipeline] Knowledge policy override → escalate (${kr.trace.policy.escalationReason}) msg=${message.id}`)
          decision = { decision: 'escalate', reason: `knowledge:${kr.trace.policy.escalationReason}` }
        }
      } else {
        retrievalMode = 'legacy'
      }

      // Step 4: Generate and optionally send response
      if (decision.decision !== 'skip' && decision.decision !== 'escalate') {
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
        "retrievalMode", "retrievalDecision", "escalationReason",
        "knowledgeRuntimeVersion", "shadowRetrievalSummary",
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
        ${retrievalMode},
        ${retrievalDecision},
        ${escalationReason},
        ${runtimeVersion},
        ${shadowSummary}::jsonb,
        NOW()
      )
    `.catch(e => console.error('[Pipeline] AiDecisionLog write error:', e.message))

    // ─── PR3: AiKnowledgeUsageLog — 1 запись на item ──────────
    // Tolerant: ошибки записи не валят pipeline.
    if (ctx.knowledgeRetrieval) {
      await this._writeUsageLog(ctx.knowledgeRetrieval, logId, message.id, replySent)
        .catch(e => console.error('[Pipeline] UsageLog write error:', e.message))
    }
  }

  /**
   * Пишет AiKnowledgeUsageLog по результатам retrieval. Одна запись на
   * каждый top-candidate. usedInReply = true только если runtime+answer
   * И item в usableItems И реально replySent.
   */
  private async _writeUsageLog(
    kr: KnowledgeRetrievalResult,
    decisionLogId: string,
    messageId: string,
    actualReplySent: boolean,
  ): Promise<void> {
    const usableSet = new Set(kr.items.map(i => i.id))
    const policyType = kr.trace.policy.type
    const escReason  = kr.trace.policy.escalationReason
    const skippedById = new Map<string, string>()
    for (const s of kr.trace.policy.skippedItems) skippedById.set(s.itemId, s.reason)

    for (const cand of kr.trace.candidates) {
      const usedInPrompt = kr.mode === 'runtime' && policyType === 'answer' && usableSet.has(cand.item.id)
      const usedInReply  = usedInPrompt && actualReplySent
      let policyDecision: string
      if (usableSet.has(cand.item.id) && policyType === 'answer') {
        policyDecision = 'used'
      } else if (skippedById.has(cand.item.id)) {
        policyDecision = 'filtered_' + skippedById.get(cand.item.id)
      } else if (policyType === 'escalate') {
        policyDecision = 'filtered_escalation'
      } else {
        policyDecision = 'filtered_no_knowledge'
      }
      const id = 'kul_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
      await recordKnowledgeUsageV1({
        contract: RECORD_KNOWLEDGE_USAGE_COMMAND_V1,
        id,
        itemId: cand.item.id,
        decisionLogId,
        messageId,
        retrievalScore: cand.prefilterScore,
        rerankScore: cand.rerankScore,
        usedInReply,
        policyDecision,
        shadowMode: kr.mode === 'shadow',
        escalationReason: escReason,
      }).catch(() => { /* tolerant per-item */ })
    }
  }
}

// Singleton — один экземпляр на весь процесс Next.js
export const pipelineWorker = new PipelineWorker()

import { prisma } from '@/lib/prisma'
import { MessageContext } from './ContextBuilder'
import { ClassificationResult } from './IntentClassifier'

export type AiDecision = 'auto_reply' | 'escalate' | 'skip'

export interface DecisionResult {
  decision: AiDecision
  reason: string
}

export class DecisionEngine {
  async decide(
    classification: ClassificationResult,
    ctx: MessageContext,
  ): Promise<DecisionResult> {
    const { config, chat } = ctx

    if (config.mode === 'off') {
      return { decision: 'skip', reason: 'mode=off' }
    }

    if (config.mode === 'operator_locked') {
      return { decision: 'escalate', reason: 'mode=operator_locked' }
    }

    // Channel whitelist
    if (config.activeChannels.length > 0 && !config.activeChannels.includes(chat.channel)) {
      return { decision: 'skip', reason: `channel=${chat.channel} not in activeChannels` }
    }

    // Confidence check
    if (classification.confidence < config.confidenceThreshold) {
      return {
        decision: 'escalate',
        reason: `confidence=${classification.confidence} < threshold=${config.confidenceThreshold}`,
      }
    }

    // suggest_only: still "auto_reply" decision but ResponseGenerator won't send
    if (config.mode === 'suggest_only') {
      return { decision: 'auto_reply', reason: 'suggest_only mode' }
    }

    // auto_reply: check daily cap per chat
    const count = await prisma.$queryRaw<{ cnt: bigint }[]>`
      SELECT COUNT(*) as cnt FROM "AiDecisionLog"
      WHERE "chatId" = ${chat.id}
        AND decision = 'auto_reply'
        AND "replySent" = true
        AND "createdAt" >= NOW() - INTERVAL '24 hours'
    `
    const replyCount = Number(count[0]?.cnt ?? 0)
    if (replyCount >= config.maxAutoRepliesPerChat) {
      return {
        decision: 'escalate',
        reason: `maxAutoRepliesPerChat=${config.maxAutoRepliesPerChat} reached today`,
      }
    }

    return { decision: 'auto_reply', reason: 'all checks passed' }
  }
}

export const decisionEngine = new DecisionEngine()

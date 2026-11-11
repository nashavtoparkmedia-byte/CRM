/**
 * The C4 simulated provider. It never imports telephony or provider code and never
 * touches a network: `originate` answers in-process, and every later fact is played into
 * Calling's existing Core (lifecycle journal, transcript journal, finalization) through the
 * same operations the Audio Bridge callbacks use for a real call. Each played event has a
 * deterministic identity, so a replayed step after a restart or a second driver is a
 * duplicate the Core recognises, never a second fact.
 */
import { changeAiCallLifecycle, appendAiCallTranscriptMessage } from '../../application/ai-call-callback-runtime'
import { finalizeAiCall } from '../../application/ai-call-finalization-runtime'
import type {
  AiConversationProviderPort,
  AiConversationSnapshotV1,
} from '../../application/ai-conversation'
import type { AiConversationSimulationVariantV1 } from '@/contracts/calling/v1/ai-conversation'
import { aiConversationFsUuid, markAiConversationAnswered } from './ai-conversation-prisma-adapter'

export const AI_CONVERSATION_SIMULATION_STEP_MS = { answer: 1_500, line: 1_400, settle: 800 } as const

type Line = { speaker: 'assistant' | 'person'; text: string }

const CONVERSATION: readonly Line[] = [
  { speaker: 'assistant', text: 'Здравствуйте! Это ассистент автопарка «Наш Автопарк». Удобно сейчас пару минут поговорить?' },
  { speaker: 'person', text: 'Да, здравствуйте, слушаю.' },
  { speaker: 'assistant', text: 'Вы оставляли заявку на работу водителем. Подскажите, вы ещё рассматриваете подключение?' },
  { speaker: 'person', text: 'Да, рассматриваю, хотел бы начать на следующей неделе.' },
  { speaker: 'assistant', text: 'Отлично. У вас есть действующее водительское удостоверение категории B и стаж больше трёх лет?' },
  { speaker: 'person', text: 'Есть, стаж пять лет.' },
  { speaker: 'assistant', text: 'Спасибо! Передам менеджеру, он свяжется с вами, чтобы договориться о встрече. Хорошего дня!' },
]

/** How many lines each variant plays before it ends. */
const LINES_PLAYED: Record<AiConversationSimulationVariantV1, number> = {
  success: CONVERSATION.length,
  interrupted: 3,
  provider_failure: 0,
  unknown_outcome: 0,
}

function eventId(conversationId: string, step: string): string {
  return `ai-conversation-sim:v1:${conversationId}:${step}`
}

async function play(snapshot: AiConversationSnapshotV1): Promise<{ nextInMs: number } | null> {
  const { record, facts } = snapshot
  const id = record.conversationId
  if (facts.endedAt !== null) return null

  if (facts.lifecycleState === 'starting' || facts.lifecycleState === null) {
    await markAiConversationAnswered(id, new Date())
    await changeAiCallLifecycle(id, {
      eventId: eventId(id, 'greeting'), source: 'audio_bridge', sourceSequence: 1, kind: 'greeting_started', target: 'greeting',
    })
    return { nextInMs: AI_CONVERSATION_SIMULATION_STEP_MS.answer }
  }

  const played = facts.transcript.length
  const total = LINES_PLAYED[record.variant]
  if (played < total) {
    const line = CONVERSATION[played]
    const ordinal = played + 1
    if (line.speaker === 'person' && facts.lifecycleState === 'greeting') {
      await changeAiCallLifecycle(id, {
        eventId: eventId(id, 'conversation'), source: 'audio_bridge', sourceSequence: 2, kind: 'conversation_started', target: 'active',
      })
    }
    const appended = await appendAiCallTranscriptMessage(id, {
      messageId: `${id}:line:${ordinal}`,
      ordinal,
      segmentRevision: 1,
      role: line.speaker === 'person' ? 'user' : 'assistant',
      content: line.text,
      final: true,
      source: 'calling_mock',
    })
    if (appended.kind === 'not_found') throw new Error('AI_CONVERSATION_SIMULATED_CALL_NOT_FOUND')
    return { nextInMs: AI_CONVERSATION_SIMULATION_STEP_MS.line }
  }

  const personLines = CONVERSATION.slice(0, total).filter(line => line.speaker === 'person').length
  const completed = record.variant === 'success'
  const finalization = await finalizeAiCall(id, {
    callUuid: aiConversationFsUuid(id),
    reason: completed ? 'completed' : 'closed',
    result: completed
      ? {
        qualification_status: 'qualified',
        lead_summary: 'Кандидат подтвердил интерес, есть ВУ категории B, стаж 5 лет. Готов начать на следующей неделе.',
        reason: null,
        qualification_score: 82,
        transfer_reason: null,
        manager_task: { should_create: false, summary: null, priority: 'normal' },
        lead_data: { simulation: true, license_category: 'B', experience_years: 5 },
      }
      : null,
    realUserUtterances: personLines,
    events: [],
  })
  if (finalization.kind === 'retryable') return { nextInMs: AI_CONVERSATION_SIMULATION_STEP_MS.settle }
  if (finalization.kind !== 'success') throw new Error(`AI_CONVERSATION_SIMULATED_FINALIZATION_${finalization.kind.toUpperCase()}`)
  return null
}

export const aiConversationSimulatedProvider: AiConversationProviderPort = {
  async originate({ conversationId, variant }) {
    if (variant === 'provider_failure') {
      return { kind: 'rejected', providerReplyExcerpt: '-ERR NO_ROUTE_DESTINATION (simulated provider)' }
    }
    if (variant === 'unknown_outcome') {
      // The command "left" and no reply was observed: Calling must treat the effect as unknown.
      throw new Error('AI_CONVERSATION_SIMULATED_ORIGINATE_REPLY_LOST')
    }
    return { kind: 'accepted', providerReference: `simulated:${conversationId}` }
  },
  progress: play,
}

export const AI_CONVERSATION_SIMULATED_SCRIPT = CONVERSATION

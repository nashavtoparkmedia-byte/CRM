'use server'

/**
 * Server actions behind the person card's «AI-звонок». The browser sends only a Contact id,
 * an opaque request id and (while simulated) a scenario variant; principal, identity,
 * permission and destination are decided server-side by Calling with Contacts' answers.
 */
import {
  AiConversationContractValidationError,
  type AiConversationsForContactResultV1,
  type StartAiConversationResultV1,
} from '@/contracts/calling/v1/ai-conversation'
import { AiConversationConflictError } from '../../application/ai-conversation'
import { listAiConversationsForContact, startAiConversation } from '../../application/ai-conversation-runtime'

export type AiConversationActionErrorV1 = 'invalid_request' | 'request_conflict' | 'unavailable'

export type AiConversationActionResultV1<T> =
  | { ok: true; result: T }
  | { ok: false; error: AiConversationActionErrorV1 }

function failure(error: unknown): { ok: false; error: AiConversationActionErrorV1 } {
  if (error instanceof AiConversationContractValidationError) return { ok: false, error: 'invalid_request' }
  if (error instanceof AiConversationConflictError) return { ok: false, error: 'request_conflict' }
  console.error('[ai-conversation] action failed:', error instanceof Error ? error.message : error)
  return { ok: false, error: 'unavailable' }
}

export async function startAiConversationActionV1(command: unknown): Promise<AiConversationActionResultV1<StartAiConversationResultV1>> {
  try {
    return { ok: true, result: await startAiConversation(command) }
  } catch (error) {
    return failure(error)
  }
}

export async function listAiConversationsForContactActionV1(query: unknown): Promise<AiConversationActionResultV1<AiConversationsForContactResultV1>> {
  try {
    return { ok: true, result: await listAiConversationsForContact(query) }
  } catch (error) {
    return failure(error)
  }
}

import 'server-only'

/**
 * Production composition of the C4 manual AI conversation. The only runtime that exists is
 * the simulator, selected exactly when Calling's existing Mock-режим (system/mockMode) is on;
 * every other state is `disabled`, so the OFF state is the default and no live provider can be
 * reached from here by configuration.
 */
import { CONTACT_COMMUNICATION_PERMISSION_QUERY_V1, CONTACT_PERSON_CARD_QUERY_V1 } from '@/contracts/contacts/v1'
import { getContactCommunicationPermissionV1, readContactPersonCardV1 } from '@/modules/contacts/public/v1'
import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import { isMockModeEnabled } from '@/lib/ai-call/provider-settings'
import type {
  AiConversationRuntimeModeV1,
  AiConversationsForContactResultV1,
  StartAiConversationResultV1,
} from '@/contracts/calling/v1/ai-conversation'
import { aiConversationPrismaStore } from '../internal/ai-calls/ai-conversation-prisma-adapter'
import { aiConversationSimulatedProvider } from '../internal/ai-calls/ai-conversation-simulated-provider'
import { createAiConversationOperations } from './ai-conversation'

export async function readAiConversationRuntimeMode(): Promise<AiConversationRuntimeModeV1> {
  try {
    return await isMockModeEnabled() ? 'simulated' : 'disabled'
  } catch {
    return 'disabled'
  }
}

const timers = new Map<string, NodeJS.Timeout>()

function wake(conversationId: string, delayMs: number): void {
  const existing = timers.get(conversationId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    timers.delete(conversationId)
    operations.advance(conversationId).catch(error => {
      opsLog('warn', 'ai_conversation_advance_failed', {
        conversationId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, Math.max(0, delayMs))
  timer.unref?.()
  timers.set(conversationId, timer)
}

const operations = createAiConversationOperations({
  mode: readAiConversationRuntimeMode,
  async principal() {
    const principal = await getIntegrationAdminPrincipal()
    return principal === null ? null : { kind: principal.kind }
  },
  readPerson: contactId => readContactPersonCardV1({ contract: CONTACT_PERSON_CARD_QUERY_V1, contactId }),
  voicePermission: contactId => getContactCommunicationPermissionV1({
    contract: CONTACT_COMMUNICATION_PERMISSION_QUERY_V1,
    contactId,
    communicationClass: 'voice',
  }),
  store: aiConversationPrismaStore,
  provider: aiConversationSimulatedProvider,
  now: () => new Date(),
  wake,
})

export async function startAiConversation(input: unknown): Promise<StartAiConversationResultV1> {
  return operations.start(input)
}

export async function listAiConversationsForContact(input: unknown): Promise<AiConversationsForContactResultV1> {
  return operations.listForContact(input)
}

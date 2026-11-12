import 'server-only'

/**
 * Production composition of the C4 manual AI conversation. The only runtime that exists is
 * the simulator, and it is selected only inside the loopback Local Preview (`YOKO_PREVIEW=1`,
 * set by the Local Controller's preview runtime, which pins every integration to a closed
 * loopback port). Everywhere else, production included, the runtime is `disabled`: the OFF
 * state is the default, and no live provider can be reached from here by configuration.
 * It deliberately reads no Calling provider setting: those live behind the reviewed
 * secret-bearing provider-settings boundary, which this path does not join.
 */
import { CONTACT_COMMUNICATION_PERMISSION_QUERY_V1, CONTACT_PERSON_CARD_QUERY_V1 } from '@/contracts/contacts/v1'
import { getContactCommunicationPermissionV1, readContactPersonCardV1 } from '@/modules/contacts/public/v1'
import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'
import { operationalLogV1 as opsLog } from '@/infrastructure/operations/operational-log'
import type {
  AiConversationRuntimeModeV1,
  AiConversationsForContactResultV1,
  StartAiConversationResultV1,
} from '@/contracts/calling/v1/ai-conversation'
import { aiConversationPrismaStore } from '../internal/ai-calls/ai-conversation-prisma-adapter'
import { aiConversationSimulatedProvider } from '../internal/ai-calls/ai-conversation-simulated-provider'
import { createAiConversationOperations } from './ai-conversation'

export async function readAiConversationRuntimeMode(): Promise<AiConversationRuntimeModeV1> {
  return process.env.YOKO_PREVIEW === '1' ? 'simulated' : 'disabled'
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

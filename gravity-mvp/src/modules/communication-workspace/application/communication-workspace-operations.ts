/**
 * Communication Workspace composition root. The one place persistence, the
 * Contacts permission query and the effects boundary are bound into the
 * execution core. Effects are simulated unless COMMUNICATION_WORKSPACE_EFFECTS
 * is exactly "live"; the live Messaging binding is never used otherwise.
 */
import { randomUUID } from 'node:crypto'
import { CONTACT_COMMUNICATION_PERMISSION_QUERY_V1 } from '../../../contracts/contacts/v1/contact-communication-policy-contracts'
import type { CommunicationMetricKeyV1 } from '../../../contracts/communication-workspace/v1'
import { getContactCommunicationPermissionV1 } from '@/modules/contacts/public/v1'
import { sendToContactV1 } from '@/modules/messaging/public/v1'
import { prismaCommunicationStoreV1 } from '../internal/prisma-communication-store'
import {
  communicationEffectsModeV1,
  createLiveCommunicationEffectsV1,
  createSimulatedCommunicationEffectsV1,
} from '../internal/communication-effects'
import { createCommunicationServiceV1, type CommunicationServiceV1, type ContactsPermissionPortV1 } from './communication-run-service'

const contactsPermission: ContactsPermissionPortV1 = {
  async check(contactId, communicationClass) {
    const result = await getContactCommunicationPermissionV1({ contract: CONTACT_COMMUNICATION_PERMISSION_QUERY_V1, contactId, communicationClass })
    if (result.decision === 'allow' && result.canonicalContactId) return { decision: 'allow', canonicalContactId: result.canonicalContactId }
    return { decision: 'deny', reason: result.reason, retryable: result.retryable, canonicalContactId: result.canonicalContactId }
  },
}

let service: CommunicationServiceV1 | null = null

function communicationService(): CommunicationServiceV1 {
  if (!service) {
    const clock = () => new Date()
    const effects = communicationEffectsModeV1(process.env) === 'live'
      ? createLiveCommunicationEffectsV1({ sendToContact: (command) => sendToContactV1(command) })
      : createSimulatedCommunicationEffectsV1(prismaCommunicationStoreV1, clock)
    service = createCommunicationServiceV1({
      store: prismaCommunicationStoreV1,
      contacts: contactsPermission,
      effects,
      clock,
      newId: () => randomUUID().replace(/-/gu, '').slice(0, 24),
    })
  }
  return service
}

export async function startCommunicationRunV1(command: unknown) {
  return communicationService().startRun(command)
}

/** Stops waiting participants that already replied, then advances due steps under leases. */
export async function advanceCommunicationRunV1(input: { runId: string; owner: string }) {
  const replies = await communicationService().detectReplies(input)
  const advanced = await communicationService().advance({ runId: input.runId, owner: input.owner })
  return { repliesStopped: replies, ...advanced }
}

export async function simulateCommunicationSandboxReplyV1(participantId: string, text: string) {
  return communicationService().simulateSandboxReply(participantId, text)
}

export async function getCommunicationRunReportV1(runId: string) {
  return communicationService().report(runId)
}

export async function listCommunicationRunParticipantsV1(runId: string, metric: CommunicationMetricKeyV1) {
  return communicationService().participants(runId, metric)
}

export async function getCommunicationParticipantTimelineV1(runId: string, audienceMemberId: string) {
  return communicationService().timeline(runId, audienceMemberId)
}

export async function listCommunicationRunsV1(limit = 20) {
  return communicationService().runs(limit)
}

export async function communicationEffectsModeForDisplayV1(): Promise<'simulated' | 'live'> {
  return communicationService().effectsMode
}

'use server'

/**
 * Отток host actions: the reference integration of a business module with
 * Communication Workspace. Отток (Fleet's trigger) says WHO and WHY; this host
 * only maps its evaluation onto the standard HostAudienceSubmission.v1 and asks
 * Communication Workspace to run a project over it. The audience is always
 * re-evaluated here, on the server: a client never supplies the people.
 */
import { randomUUID } from 'node:crypto'
import { requireIntegrationAdminAccess } from '@/modules/identity-access/public/v1'
import { evaluateChurnInactivityTriggerV1 } from '@/modules/fleet-operations/public/v1'
import {
  CHURN_RETURN_PROJECT_V1,
  HOST_AUDIENCE_SUBMISSION_V1,
  START_COMMUNICATION_RUN_COMMAND_V1,
  advanceCommunicationRunV1,
  simulateCommunicationSandboxReplyV1,
  startCommunicationRunV1,
  type SimulatedCallOutcomeV1,
  type SimulatedMessageOutcomeV1,
  type StartCommunicationRunResultV1,
} from '@/modules/communication-workspace/public/v1'

export interface ChurnCandidateView {
  driverId: string
  contactId: string
  fullName: string
  lastOrderAt: string
  inactiveDays: number
}

export interface ChurnEvaluationView {
  minInactiveDays: number
  asOf: string
  matched: ChurnCandidateView[]
  withoutContact: number
  truncated: boolean
}

export async function evaluateChurnTriggerAction(minInactiveDays: number): Promise<ChurnEvaluationView> {
  await requireIntegrationAdminAccess()
  const evaluation = await evaluateChurnInactivityTriggerV1({ minInactiveDays })
  return {
    minInactiveDays: evaluation.minInactiveDays,
    asOf: evaluation.asOf,
    matched: evaluation.matched,
    withoutContact: evaluation.withoutContact.length,
    truncated: evaluation.truncated,
  }
}

export interface StartChurnSandboxRunInput {
  /** One per opened form: the same key is the same Run, never a second one. */
  requestKey: string
  minInactiveDays: number
  allowlistContactIds: string[]
  waitSeconds: number
  cooldownSeconds: number
  simulatedOutcomes: Record<string, { message?: SimulatedMessageOutcomeV1; call?: SimulatedCallOutcomeV1 }>
}

export async function startChurnSandboxRunAction(input: StartChurnSandboxRunInput): Promise<StartCommunicationRunResultV1> {
  const principal = await requireIntegrationAdminAccess()
  if (typeof input?.requestKey !== 'string' || !/^[A-Za-z0-9-]{8,64}$/u.test(input.requestKey)) throw new Error('requestKey is required')
  const evaluation = await evaluateChurnInactivityTriggerV1({ minInactiveDays: input.minInactiveDays })
  return startCommunicationRunV1({
    contract: START_COMMUNICATION_RUN_COMMAND_V1,
    projectKey: CHURN_RETURN_PROJECT_V1.key,
    mode: 'sandbox',
    audience: {
      contract: HOST_AUDIENCE_SUBMISSION_V1,
      hostModule: 'churn',
      triggerKey: evaluation.triggerKey,
      triggerVersion: evaluation.triggerVersion,
      snapshotRef: `churn-ui:${input.requestKey}`,
      evaluatedAt: evaluation.asOf,
      criteria: { minInactiveDays: evaluation.minInactiveDays, threshold: evaluation.threshold, withoutContact: evaluation.withoutContact.length },
      members: evaluation.matched.map((match) => ({
        contactId: match.contactId,
        reason: `Нет заказов ${match.inactiveDays} дн. (условие: ≥ ${evaluation.minInactiveDays})`,
        sourceRef: `driver:${match.driverId}`,
        businessContext: {
          displayName: match.fullName,
          driverId: match.driverId,
          lastOrderAt: match.lastOrderAt,
          inactiveDays: match.inactiveDays,
          minInactiveDays: evaluation.minInactiveDays,
        },
      })),
    },
    sandbox: {
      allowlistContactIds: input.allowlistContactIds,
      waitSecondsOverride: input.waitSeconds,
      cooldownSecondsOverride: input.cooldownSeconds,
      simulatedOutcomes: input.simulatedOutcomes,
    },
    requestedBy: principal.id,
  })
}

export async function advanceRunAction(runId: string) {
  await requireIntegrationAdminAccess()
  return advanceCommunicationRunV1({ runId, owner: `ui-${randomUUID().slice(0, 8)}` })
}

export async function simulateReplyAction(participantId: string) {
  await requireIntegrationAdminAccess()
  return simulateCommunicationSandboxReplyV1(participantId, 'Да, выйду на линию завтра')
}

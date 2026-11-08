import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Communication Workspace against real PostgreSQL: the real store (guards with
// row locks, SKIP LOCKED leases, version-checked transitions, the unique
// idempotency key and dedupe key), the real Contacts lineage and permission
// read over real Contact and ContactCommunicationPolicy rows, and the
// simulated effects (which record each effect once in the audit trail).
//
// Runs only against a disposable, fully migrated database named by
// COMMUNICATION_WORKSPACE_TEST_DATABASE_URL (DATABASE_URL must point at the same
// database); skipped otherwise.

const TEST_DATABASE_URL = process.env.COMMUNICATION_WORKSPACE_TEST_DATABASE_URL
const describeWithDatabase = TEST_DATABASE_URL ? describe : describe.skip

import { prisma } from '@/lib/prisma'
import { CONTACT_COMMUNICATION_PERMISSION_QUERY_V1 } from '../../../contracts/contacts/v1/contact-communication-policy-contracts'
import { HOST_AUDIENCE_SUBMISSION_V1, START_COMMUNICATION_RUN_COMMAND_V1 } from '../../../contracts/communication-workspace/v1'
import { getContactCommunicationPermissionV1 } from '@/modules/contacts/public/v1'
import { prismaCommunicationStoreV1 } from '../internal/prisma-communication-store'
import { createSimulatedCommunicationEffectsV1 } from '../internal/communication-effects'
import { createCommunicationServiceV1, type ContactsPermissionPortV1 } from './communication-run-service'

const RUN = `cw${Date.now().toString(36)}`
const contact = (name: string) => `${RUN}_${name}`
let now = new Date()
const clock = () => now
let seq = 0
const newId = () => `${RUN}${(seq += 1).toString(36).padStart(5, '0')}`

const contacts: ContactsPermissionPortV1 = {
  async check(contactId, communicationClass) {
    const result = await getContactCommunicationPermissionV1({ contract: CONTACT_COMMUNICATION_PERMISSION_QUERY_V1, contactId, communicationClass })
    if (result.decision === 'allow' && result.canonicalContactId) return { decision: 'allow', canonicalContactId: result.canonicalContactId }
    return { decision: 'deny', reason: result.reason, retryable: result.retryable, canonicalContactId: result.canonicalContactId }
  },
}

function service() {
  return createCommunicationServiceV1({ store: prismaCommunicationStoreV1, contacts, effects: createSimulatedCommunicationEffectsV1(prismaCommunicationStoreV1, clock), clock, newId })
}

function command(ids: string[], snapshotRef: string, projectKey = 'churn-return-v1') {
  return {
    contract: START_COMMUNICATION_RUN_COMMAND_V1,
    projectKey,
    mode: 'sandbox',
    audience: {
      contract: HOST_AUDIENCE_SUBMISSION_V1,
      hostModule: 'churn',
      triggerKey: 'fleet.churn.no_orders_days',
      triggerVersion: 1,
      snapshotRef: `${RUN}:${snapshotRef}`,
      evaluatedAt: now.toISOString(),
      criteria: { minInactiveDays: 5 },
      members: ids.map((id) => ({ contactId: id, reason: 'Нет заказов 7 дн.', sourceRef: `driver:${id}`, businessContext: { displayName: id } })),
    },
    sandbox: { allowlistContactIds: ids.slice(0, 20), waitSecondsOverride: 5, cooldownSecondsOverride: 30, simulatedOutcomes: {} },
    requestedBy: 'postgres-proof',
  }
}

async function effects(runId: string, effect: 'message' | 'call') {
  return prisma.communicationExecutionEvent.count({ where: { runId, kind: 'simulated_provider_effect', detail: { path: ['effect'], equals: effect } } })
}

describeWithDatabase('Communication Workspace on PostgreSQL', () => {
  const ids = Array.from({ length: 12 }, (_, index) => contact(`p${index}`))
  beforeAll(async () => {
    await prisma.contact.createMany({ data: [...ids, contact('dnd'), contact('shared'), contact('lease')].map((id) => ({ id, displayName: id })) })
    await prisma.contactCommunicationPolicy.create({ data: { contactId: contact('dnd'), denyAll: true, version: 1, updatedBy: 'postgres-proof' } })
  })
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('concurrent copies of one host snapshot create exactly one Run', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => service().startRun(command([ids[0], ids[1]], 'dup'))))
    const runIds = new Set(results.map((result) => ('runId' in result ? result.runId : 'refused')))
    expect(runIds.size).toBe(1)
    expect(results.filter((result) => result.outcome === 'started')).toHaveLength(1)
    expect(await prisma.communicationRun.count({ where: { snapshotRef: `${RUN}:dup` } })).toBe(1)
  })

  it('two projects admitting the same Contact concurrently: exactly one participation is active', async () => {
    const [churn, documents] = await Promise.all([
      service().startRun(command([contact('shared')], 'x-churn')),
      service().startRun(command([contact('shared')], 'x-docs', 'documents-reminder-v1')),
    ])
    const admitted = [churn, documents].map((result) => ('admitted' in result ? result.admitted : 0))
    expect(admitted.sort()).toEqual([0, 1])
    const guard = await prisma.communicationContactGuard.findUnique({ where: { scope_canonicalContactId: { scope: 'sandbox', canonicalContactId: contact('shared') } } })
    expect(guard?.activeParticipantId).toBeTruthy()
    const excluded = await prisma.communicationAudienceMember.findFirst({ where: { requestedContactId: contact('shared'), admission: 'excluded' } })
    expect(excluded?.exclusionReason).toBe('suppressed_active_elsewhere')
  })

  it('global "do not disturb" in Contacts excludes the Contact (real Contacts permission read)', async () => {
    const result = await service().startRun(command([contact('dnd'), ids[2]], 'dnd'))
    expect(result).toMatchObject({ outcome: 'started', admitted: 1, excluded: 1 })
    const member = await prisma.communicationAudienceMember.findFirst({ where: { requestedContactId: contact('dnd') } })
    expect(member?.exclusionReason).toBe('contact_restricted')
  })

  it('four concurrent workers: every step happens once, every Contact ends once', async () => {
    const started = await service().startRun(command(ids.slice(3, 12), 'workers'))
    if (started.outcome === 'refused') throw new Error('refused')
    expect(started.admitted).toBe(9)
    for (let round = 0; round < 4; round += 1) {
      await Promise.all(['A', 'B', 'C', 'D'].map((owner) => service().advance({ runId: started.runId, owner })))
      now = new Date(now.getTime() + 6_000)
    }
    expect(await effects(started.runId, 'message')).toBe(9)
    expect(await effects(started.runId, 'call')).toBe(9)
    const states = await prisma.communicationParticipantExecution.groupBy({ by: ['state', 'outcome'], where: { runId: started.runId }, _count: true })
    expect(states).toEqual([{ state: 'completed', outcome: 'call_answered', _count: 9 }])
    const requested = await prisma.communicationExecutionEvent.count({ where: { runId: started.runId, kind: 'message_requested' } })
    expect(requested).toBe(9)
    // Ended participations release their guard into cooldown.
    const guards = await prisma.communicationContactGuard.findMany({ where: { scope: 'sandbox', canonicalContactId: { in: ids.slice(3, 12) } } })
    expect(guards.every((guard) => guard.activeParticipantId === null && guard.cooldownUntil !== null)).toBe(true)
  })

  it('a worker that dies holding a lease: nobody else steps before it expires; afterwards the step happens once', async () => {
    const started = await service().startRun(command([contact('lease')], 'lease'))
    if (started.outcome === 'refused') throw new Error('refused')
    const leased = await prismaCommunicationStoreV1.claimDue({ runId: started.runId, now, owner: 'dead-worker', leaseUntil: new Date(now.getTime() + 30_000), limit: 10 })
    expect(leased).toHaveLength(1)
    expect((await service().advance({ runId: started.runId, owner: 'B' })).claimed).toBe(0)
    now = new Date(now.getTime() + 31_000)
    expect((await service().advance({ runId: started.runId, owner: 'B' })).claimed).toBe(1)
    expect(await effects(started.runId, 'message')).toBe(1)
    // The dead worker's stale version can no longer move the execution.
    const stale = await prismaCommunicationStoreV1.transition({ id: leased[0].id, owner: 'dead-worker', fromVersion: leased[0].version, patch: { state: 'failed' }, events: [], releaseGuard: null, now })
    expect(stale).toBe(false)
  })

  it('the audit trail is append-only per dedupe key and read back in insertion order', async () => {
    const run = await prisma.communicationRun.findFirstOrThrow({ where: { snapshotRef: `${RUN}:workers` } })
    const first = await prisma.communicationExecutionEvent.findFirstOrThrow({ where: { runId: run.id }, orderBy: { seq: 'asc' } })
    expect(await prismaCommunicationStoreV1.appendEvent({ ...first, id: `${first.id}-again`, detail: {} })).toBe(false)
    const events = await prismaCommunicationStoreV1.listEvents(run.id)
    expect(events[0].kind).toBe('trigger_evaluated')
    const perParticipant = events.filter((item) => item.participantId === events.find((e) => e.kind === 'call_answered')?.participantId).map((item) => item.kind)
    expect(perParticipant.indexOf('message_requested')).toBeLessThan(perParticipant.indexOf('wait_started'))
    expect(perParticipant.indexOf('wait_started')).toBeLessThan(perParticipant.indexOf('call_requested'))
    expect(perParticipant.at(-1)).toBe('call_answered')
  })
})

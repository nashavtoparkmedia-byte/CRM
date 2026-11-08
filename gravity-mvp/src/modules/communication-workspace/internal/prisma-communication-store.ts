/**
 * Communication Workspace persistence, owner-local. Only this adapter touches
 * the six Communication* tables; it touches nothing else.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { decideGuardV1, type CommunicationProjectDefinitionV1 } from '../application/communication-policy'
import type {
  CommunicationEventRowV1,
  CommunicationExecutionRowV1,
  CommunicationMemberRowV1,
  CommunicationRunRowV1,
  CommunicationStorePortV1,
} from '../application/communication-run-service'

type Json = Prisma.InputJsonValue

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

class RunAlreadyExists extends Error {}

function toExecution(row: {
  id: string; runId: string; audienceMemberId: string; canonicalContactId: string; state: string; nextActionAt: Date | null
  version: number; attempts: number; messageRequestId: string | null; messageOutcome: string | null; messageAcceptedAt: Date | null
  callRequestId: string | null; callOutcome: string | null; outcome: string | null
}): CommunicationExecutionRowV1 {
  return {
    id: row.id,
    runId: row.runId,
    audienceMemberId: row.audienceMemberId,
    canonicalContactId: row.canonicalContactId,
    state: row.state as CommunicationExecutionRowV1['state'],
    nextActionAt: row.nextActionAt,
    version: row.version,
    attempts: row.attempts,
    messageRequestId: row.messageRequestId,
    messageOutcome: row.messageOutcome,
    messageAcceptedAt: row.messageAcceptedAt,
    callRequestId: row.callRequestId,
    callOutcome: row.callOutcome,
    outcome: row.outcome as CommunicationExecutionRowV1['outcome'],
  }
}

function toEvent(row: { id: string; runId: string; participantId: string | null; dedupeKey: string; kind: string; detail: unknown; occurredAt: Date }): CommunicationEventRowV1 {
  return { id: row.id, runId: row.runId, participantId: row.participantId, dedupeKey: row.dedupeKey, kind: row.kind, detail: (row.detail ?? {}) as CommunicationEventRowV1['detail'], occurredAt: row.occurredAt }
}

const EXECUTION_SELECT = {
  id: true, runId: true, audienceMemberId: true, canonicalContactId: true, state: true, nextActionAt: true, version: true, attempts: true,
  messageRequestId: true, messageOutcome: true, messageAcceptedAt: true, callRequestId: true, callOutcome: true, outcome: true,
} as const

export const prismaCommunicationStoreV1: CommunicationStorePortV1 = {
  async ensureProject(definition: CommunicationProjectDefinitionV1) {
    const existing = await prisma.communicationProject.findUnique({ where: { key: definition.key }, select: { id: true } })
    if (existing) return existing
    try {
      return await prisma.communicationProject.create({
        data: {
          id: `cwp-${definition.key}`,
          key: definition.key,
          title: definition.title,
          hostModule: definition.hostModule,
          flowVersion: definition.flow.version,
          flow: definition.flow as unknown as Json,
          policy: definition.policy as unknown as Json,
        },
        select: { id: true },
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      return prisma.communicationProject.findUniqueOrThrow({ where: { key: definition.key }, select: { id: true } })
    }
  },

  async findRunByIdempotencyKey(idempotencyKey) {
    const row = await prisma.communicationRun.findUnique({ where: { idempotencyKey }, select: { id: true } })
    return row ? this.readRun(row.id) : null
  },

  async createRun({ run, members, candidates, scope, now }) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        try {
          await tx.communicationRun.create({
            data: {
              ...run,
              criteria: run.criteria as Json,
              flow: run.flow as unknown as Json,
              policy: run.policy as unknown as Json,
              sandbox: run.sandbox ? (run.sandbox as unknown as Json) : Prisma.JsonNull,
            },
          })
        } catch (error) {
          if (isUniqueViolation(error)) throw new RunAlreadyExists()
          throw error
        }
        const finalMembers = new Map(members.map((member) => [member.id, { ...member }]))
        const executions: Prisma.CommunicationParticipantExecutionCreateManyInput[] = []
        const events: Prisma.CommunicationExecutionEventCreateManyInput[] = []
        // Guards are locked in one global order, so two Runs never deadlock on each other.
        const ordered = [...candidates].sort((left, right) => left.canonicalContactId.localeCompare(right.canonicalContactId))
        for (const candidate of ordered) {
          await tx.$executeRaw`INSERT INTO "CommunicationContactGuard" ("scope", "canonicalContactId", "updatedAt") VALUES (${scope}, ${candidate.canonicalContactId}, ${now}) ON CONFLICT DO NOTHING`
          const [guard] = await tx.$queryRaw<Array<{ activeParticipantId: string | null; cooldownUntil: Date | null }>>`
            SELECT "activeParticipantId", "cooldownUntil" FROM "CommunicationContactGuard"
            WHERE "scope" = ${scope} AND "canonicalContactId" = ${candidate.canonicalContactId} FOR UPDATE`
          const verdict = decideGuardV1(guard ?? null, now)
          const member = finalMembers.get(candidate.memberId)!
          if (verdict !== 'free') {
            member.admission = 'excluded'
            member.exclusionReason = verdict
            continue
          }
          await tx.$executeRaw`UPDATE "CommunicationContactGuard" SET "activeParticipantId" = ${candidate.participantId}, "activeProjectId" = ${run.projectId}, "updatedAt" = ${now}
            WHERE "scope" = ${scope} AND "canonicalContactId" = ${candidate.canonicalContactId}`
          executions.push({
            id: candidate.participantId,
            runId: run.id,
            audienceMemberId: candidate.memberId,
            canonicalContactId: candidate.canonicalContactId,
            state: 'admitted',
            nextActionAt: now,
          })
        }
        const participantByMember = new Map(executions.map((execution) => [execution.audienceMemberId, execution.id]))
        await tx.communicationAudienceMember.createMany({
          data: [...finalMembers.values()].map((member) => ({ ...member, businessContext: member.businessContext as Json })),
        })
        if (executions.length > 0) await tx.communicationParticipantExecution.createMany({ data: executions })
        events.push({
          id: `${run.id}-trigger`,
          runId: run.id,
          participantId: null,
          dedupeKey: `${run.id}:trigger_evaluated`,
          kind: 'trigger_evaluated',
          detail: { triggerKey: run.triggerKey, triggerVersion: run.triggerVersion, snapshotRef: run.snapshotRef, matched: members.length, ...run.criteria } as Json,
          occurredAt: run.evaluatedAt,
        })
        for (const member of finalMembers.values()) {
          events.push({
            id: `${run.id}-adm-${member.id}`,
            runId: run.id,
            participantId: participantByMember.get(member.id) ?? null,
            dedupeKey: `${run.id}:admission:${member.id}`,
            kind: member.admission === 'admitted' ? 'contact_admitted' : 'contact_excluded',
            detail: {
              audienceMemberId: member.id,
              requestedContactId: member.requestedContactId,
              canonicalContactId: member.canonicalContactId,
              reason: member.reason,
              exclusionReason: member.exclusionReason,
              mode: run.mode,
            } as Json,
            occurredAt: now,
          })
        }
        await tx.communicationExecutionEvent.createMany({ data: events })
        return { created: true as const, admitted: executions.length, guardExcluded: candidates.length - executions.length }
      }, { timeout: 120_000, maxWait: 30_000 })
      return result
    } catch (error) {
      if (!(error instanceof RunAlreadyExists) && !isUniqueViolation(error)) throw error
      const existing = await prisma.communicationRun.findUnique({ where: { idempotencyKey: run.idempotencyKey }, select: { id: true } })
      if (!existing) throw error
      return { created: false as const, existingRunId: existing.id }
    }
  },

  async listRuns(limit) {
    const rows = await prisma.communicationRun.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      select: { id: true, projectId: true, mode: true, triggerKey: true, snapshotRef: true, createdAt: true },
    })
    const projects = new Map((await prisma.communicationProject.findMany({ select: { id: true, key: true, title: true } })).map((project) => [project.id, project]))
    return rows.map((row) => ({
      id: row.id,
      projectKey: projects.get(row.projectId)?.key ?? 'unknown',
      projectTitle: projects.get(row.projectId)?.title ?? 'unknown',
      mode: row.mode as CommunicationRunRowV1['mode'],
      triggerKey: row.triggerKey,
      snapshotRef: row.snapshotRef,
      createdAt: row.createdAt,
    }))
  },

  async readRun(runId) {
    const run = await prisma.communicationRun.findUnique({ where: { id: runId } })
    if (!run) return null
    const project = await prisma.communicationProject.findUnique({ where: { id: run.projectId }, select: { key: true, title: true } })
    return {
      ...run,
      projectKey: project?.key ?? 'unknown',
      projectTitle: project?.title ?? 'unknown',
      mode: run.mode as CommunicationRunRowV1['mode'],
      criteria: run.criteria as CommunicationRunRowV1['criteria'],
      flow: run.flow as unknown as CommunicationRunRowV1['flow'],
      policy: run.policy as unknown as CommunicationRunRowV1['policy'],
      sandbox: (run.sandbox ?? null) as unknown as CommunicationRunRowV1['sandbox'],
    }
  },

  async listMembers(runId) {
    const rows = await prisma.communicationAudienceMember.findMany({ where: { runId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    return rows.map((row): CommunicationMemberRowV1 => ({
      id: row.id,
      runId: row.runId,
      requestedContactId: row.requestedContactId,
      canonicalContactId: row.canonicalContactId,
      reason: row.reason,
      sourceRef: row.sourceRef,
      businessContext: row.businessContext as CommunicationMemberRowV1['businessContext'],
      admission: row.admission as CommunicationMemberRowV1['admission'],
      exclusionReason: row.exclusionReason as CommunicationMemberRowV1['exclusionReason'],
    }))
  },

  async listExecutions(runId) {
    return (await prisma.communicationParticipantExecution.findMany({ where: { runId }, select: EXECUTION_SELECT, orderBy: { id: 'asc' } })).map(toExecution)
  },

  async readExecution(participantId) {
    const row = await prisma.communicationParticipantExecution.findUnique({ where: { id: participantId }, select: EXECUTION_SELECT })
    return row ? toExecution(row) : null
  },

  async listEvents(runId, participantId) {
    const rows = await prisma.communicationExecutionEvent.findMany({
      where: { runId, ...(participantId ? { participantId } : {}) },
      orderBy: { seq: 'asc' },
    })
    return rows.map(toEvent)
  },

  async claimDue({ runId, now, owner, leaseUntil, limit }) {
    const rows = await prisma.$queryRaw<Array<Parameters<typeof toExecution>[0]>>`
      UPDATE "CommunicationParticipantExecution" SET "leaseOwner" = ${owner}, "leaseUntil" = ${leaseUntil}
      WHERE "id" IN (
        SELECT "id" FROM "CommunicationParticipantExecution"
        WHERE "state" IN ('admitted', 'waiting_reply', 'calling')
          AND ("nextActionAt" IS NULL OR "nextActionAt" <= ${now})
          AND ("leaseUntil" IS NULL OR "leaseUntil" < ${now})
          AND (${runId}::text IS NULL OR "runId" = ${runId})
        ORDER BY "nextActionAt" ASC NULLS FIRST, "id" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "runId", "audienceMemberId", "canonicalContactId", "state", "nextActionAt", "version", "attempts",
        "messageRequestId", "messageOutcome", "messageAcceptedAt", "callRequestId", "callOutcome", "outcome"`
    return rows.map(toExecution)
  },

  async transition({ id, owner, fromVersion, patch, events, releaseGuard, now }) {
    return prisma.$transaction(async (tx) => {
      const terminal = releaseGuard !== null
      // The lease goes with the step: kept only while this worker may act again at once.
      const release = terminal || (patch.nextActionAt instanceof Date && patch.nextActionAt.getTime() > now.getTime())
      const moved = await tx.communicationParticipantExecution.updateMany({
        where: {
          id,
          version: fromVersion,
          OR: [{ leaseOwner: owner }, { leaseOwner: null }, { leaseUntil: { lt: now } }],
        },
        data: {
          ...patch,
          version: { increment: 1 },
          ...(release ? { leaseOwner: null, leaseUntil: null } : {}),
        },
      })
      if (moved.count !== 1) return false
      if (events.length > 0) {
        await tx.communicationExecutionEvent.createMany({
          data: events.map((item) => ({ ...item, detail: item.detail as Json })),
          skipDuplicates: true,
        })
      }
      if (releaseGuard) {
        await tx.$executeRaw`UPDATE "CommunicationContactGuard"
          SET "activeParticipantId" = NULL, "activeProjectId" = NULL, "lastProjectId" = ${releaseGuard.projectId},
              "cooldownUntil" = ${releaseGuard.cooldownUntil}, "updatedAt" = ${now}
          WHERE "scope" = ${releaseGuard.scope} AND "canonicalContactId" = ${releaseGuard.canonicalContactId} AND "activeParticipantId" = ${id}`
      }
      return true
    })
  },

  async appendEvent(item) {
    const created = await prisma.communicationExecutionEvent.createMany({ data: [{ ...item, detail: item.detail as Json }], skipDuplicates: true })
    return created.count === 1
  },

  async findEvent(dedupeKey) {
    const row = await prisma.communicationExecutionEvent.findUnique({ where: { dedupeKey } })
    return row ? toEvent(row) : null
  },
}

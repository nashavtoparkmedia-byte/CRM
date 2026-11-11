import 'server-only'

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type {
  ManualCallClaimResult,
  ManualCallDispatchState,
  ManualCallRecord,
  ManualCallStorePort,
} from '../../application/manual-call'

export const MANUAL_CALL_METADATA_KEY = 'manualCallV1'
/** A ringing or active outbound call newer than this keeps its Contact and its employee busy. */
export const MANUAL_CALL_LIVE_HORIZON_MS = 2 * 60 * 60 * 1000

const DISPATCH: readonly ManualCallDispatchState[] = ['claimed', 'accepted', 'rejected', 'unavailable', 'outcome_unknown']

type ManualCallMetadata = {
  version: 1
  requestId: string
  payloadDigest: string
  phoneId: string
  extension: string
  dispatch: ManualCallDispatchState
}

function readManualMetadata(metadata: Prisma.JsonValue | null): ManualCallMetadata | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null
  const value = (metadata as Record<string, unknown>)[MANUAL_CALL_METADATA_KEY]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.payloadDigest !== 'string' || typeof record.requestId !== 'string') return null
  if (typeof record.phoneId !== 'string' || typeof record.extension !== 'string') return null
  if (!DISPATCH.includes(record.dispatch as ManualCallDispatchState)) return null
  return {
    version: 1,
    requestId: record.requestId,
    payloadDigest: record.payloadDigest,
    phoneId: record.phoneId,
    extension: record.extension,
    dispatch: record.dispatch as ManualCallDispatchState,
  }
}

export const manualCallPrismaStore: ManualCallStorePort = {
  async claim(record: ManualCallRecord): Promise<ManualCallClaimResult> {
    return prisma.$transaction(async (tx: Prisma.TransactionClient): Promise<ManualCallClaimResult> => {
      // One writer per person and per employee; keys are taken in a fixed order so two claims never deadlock.
      const [firstKey, secondKey] = [
        `calling.manual-call.contact:${record.contactId}`,
        `calling.manual-call.staff:${record.staffUserId}`,
      ].sort()
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${firstKey}, 0))`
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${secondKey}, 0))`

      const existing = await tx.call.findUnique({ where: { id: record.callId }, select: { metadata: true } })
      if (existing) {
        const metadata = readManualMetadata(existing.metadata)
        // A row under this id that is not a manual-call record can never be a replay of this request.
        if (!metadata) return { kind: 'existing', payloadDigest: '', dispatch: 'outcome_unknown' }
        return { kind: 'existing', payloadDigest: metadata.payloadDigest, dispatch: metadata.dispatch }
      }

      const createdAt = new Date(record.createdAt)
      const horizon = new Date(createdAt.getTime() - MANUAL_CALL_LIVE_HORIZON_MS)
      const live = await tx.call.findFirst({
        where: {
          direction: 'outbound',
          status: { in: ['ringing', 'active'] },
          startedAt: { gte: horizon },
          OR: [{ contactId: record.contactId }, { managerId: record.staffUserId }],
        },
        select: { id: true },
      })
      if (live) return { kind: 'busy' }

      await tx.call.create({
        data: {
          id: record.callId,
          direction: 'outbound',
          status: 'ringing',
          fromNumber: process.env.MEGAFON_NUMBER?.trim() ?? '',
          toNumber: record.e164,
          driverId: record.driverId,
          contactId: record.contactId,
          managerId: record.staffUserId,
          fsUuid: record.fsUuid,
          startedAt: createdAt,
          metadata: {
            manualCallV1: {
              version: 1,
              requestId: record.requestId,
              payloadDigest: record.payloadDigest,
              phoneId: record.phoneId,
              extension: record.extension,
              dispatch: 'claimed',
            },
          },
        },
      })
      return { kind: 'claimed' }
    })
  },

  async settle(callId, dispatch) {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const row = await tx.call.findUnique({ where: { id: callId }, select: { metadata: true } })
      const metadata = row ? readManualMetadata(row.metadata) : null
      if (!metadata) return
      const failed = dispatch === 'rejected' || dispatch === 'unavailable'
      await tx.call.update({
        where: { id: callId },
        data: {
          status: failed ? 'failed' : undefined,
          endedAt: failed ? new Date() : undefined,
          hangupCause: failed ? `MANUAL_CALL_${dispatch.toUpperCase()}` : undefined,
          metadata: {
            manualCallV1: {
              version: 1,
              requestId: metadata.requestId,
              payloadDigest: metadata.payloadDigest,
              phoneId: metadata.phoneId,
              extension: metadata.extension,
              dispatch,
            },
          },
        },
      })
    })
  },

  async findByFsUuid(fsUuid) {
    const row = await prisma.call.findUnique({
      where: { fsUuid },
      select: { id: true, direction: true, status: true, managerId: true },
    })
    if (!row || row.direction !== 'outbound') return null
    return { callId: row.id, staffUserId: row.managerId, active: row.status === 'ringing' || row.status === 'active' }
  },
}
